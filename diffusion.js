import { setTimeout as sleep } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

// Default total artificial delay per response, so long bursts never stall the agent.
export const DEFAULT_MAX_HOLD_MS = 2000;

// Each Inception frame is the complete text so far, with undecoded regions still noisy.
// Tool, reasoning and usage data pass through untouched; the final frame becomes the
// single text delta the transport commits. Inception repeats finish_reason in a trailing
// empty chunk, so only the first finish commits text.
export function diffusionBody(body, onFrame, onEvent) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let draft;
  let finished = false;

  async function frame(raw, controller) {
    // Per the SSE spec, an event's data lines join with "\n", so JSON split between tokens
    // still parses. Inception sends each JSON event on one line; a raw newline inside a JSON
    // string is invalid JSON and errors the stream instead of committing partial text.
    const data = raw.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    const event = JSON.parse(data);
    await onEvent?.(event);
    const choice = event.choices?.[0];
    const isFrame = typeof choice?.delta?.content === "string";
    if (isFrame) {
      draft = choice.delta.content;
      await onFrame(draft);
    }
    const commit = Boolean(choice?.finish_reason) && !finished && draft !== undefined;
    if (choice?.finish_reason) finished = true;
    const forwarded = isFrame || commit
      ? { ...event, choices: [{ ...choice, delta: { ...choice.delta, content: commit ? draft : null } }] }
      : event;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(forwarded)}\n\n`));
  }

  return body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        await frame(raw, controller);
      }
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) await frame(buffer, controller);
    },
  }));
}

// Frames arrive in bursts (several per decoded block), so each one is held on screen for
// at least frameMs, up to maxHoldMs in total per response. Aborting ends any hold immediately.
function createPacer(frameMs, maxHoldMs, signal) {
  let shownAt = 0;
  let held = 0;
  return async () => {
    const wait = Math.min(frameMs - (Date.now() - shownAt), maxHoldMs - held);
    if (wait > 0 && !signal?.aborted) {
      held += wait;
      await sleep(wait, undefined, { signal }).catch(() => {});
    }
    shownAt = Date.now();
  };
}

// Intermediate frames are untrusted model output shown raw, so strip terminal controls.
// The committed text stays verbatim, like any other provider's output.
const sanitize = (text) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function errorResult(model, error) {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
  };
}

export function createInceptionStream(transport, getFrameMs = () => 0, getMaxHoldMs = () => DEFAULT_MAX_HOLD_MS) {
  return (model, context, options = {}) => {
    const outer = createAssistantMessageEventStream();
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const pace = createPacer(getFrameMs(), getMaxHoldMs(), options.signal);
    let partial;
    const show = async (text) => {
      if (!partial) return;
      await pace();
      // Pi re-renders the streaming message from `partial`, so a replaced text block
      // overwrites the previous frame in place instead of appending to it.
      const content = [...partial.content, { type: "text", text: sanitize(text) }];
      outer.push({ type: "text_delta", contentIndex: content.length - 1, delta: "", partial: { ...partial, content } });
    };
    const inner = transport(model, context, {
      ...options,
      onProviderStreamEvent: undefined,
      async onPayload(payload, requestModel) {
        const proposed = { ...payload, diffusing: true };
        return (await options.onPayload?.(proposed, requestModel)) ?? proposed;
      },
      async fetch(input, init) {
        const response = await fetchImpl(input, init);
        if (!response.ok || !response.body) return response;
        const body = diffusionBody(response.body, show, (event) => options.onProviderStreamEvent?.(event, model));
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      },
    });
    (async () => {
      for await (const event of inner) {
        if (event.type === "start") partial = event.partial;
        outer.push(event);
      }
    })().catch((error) => {
      outer.push({ type: "error", reason: "error", error: errorResult(model, error) });
    }).finally(() => outer.end());
    return outer;
  };
}
