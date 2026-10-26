import test from "node:test";
import assert from "node:assert/strict";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import inception from "../index.js";
import { createInceptionStream } from "../diffusion.js";

// The same transport the extension registers.
const streamSimple = openAICompletionsApi().streamSimple;

function load() {
  const registration = { handlers: {} };
  inception({
    registerProvider(name, config) {
      assert.equal(name, "inception");
      registration.config = config;
    },
    on(event, handler) {
      registration.handlers[event] = handler;
    },
  });
  return registration;
}

const { config } = load();
const model = { ...config.models[0], provider: "inception", api: config.api, baseUrl: config.baseUrl };
const context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
const chunk = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
const encode = (events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
function body(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Deliberately split UTF-8 characters and SSE delimiters across reads.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
}
// The whole response in one read, so several events share a chunk.
const whole = (text) =>
  new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }, 0);
    },
  });
async function run(stream, events, extra = {}) {
  const started = performance.now();
  const s = stream(model, context, {
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => new Response(typeof events === "string" ? body(events) : body(encode(events))),
    ...extra,
  });
  const emitted = [];
  for await (const event of s) emitted.push(event);
  return { emitted, result: await s.result(), elapsed: performance.now() - started };
}
// Synthetic frame events carry an empty delta and the frame as the trailing text block.
const frames = (emitted) =>
  emitted.filter((e) => e.type === "text_delta" && e.delta === "").map((e) => e.partial.content.at(-1).text);
const committed = (emitted) => emitted.filter((e) => e.type === "text_delta" && e.delta !== "").map((e) => e.delta);
const text = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text);

test("frames overwrite the streaming message and only the final text is committed", async () => {
  const raw = [];
  let payload;
  const events = [chunk("noisy"), chunk("Hello 世界"), chunk("Hello 🌍", "stop"), finish, usage];
  const { emitted, result } = await run(createInceptionStream(streamSimple), events, {
    onPayload(value) {
      assert.equal(value.diffusing, true);
      return value;
    },
    onProviderStreamEvent(value) {
      raw.push(value);
    },
    fetch: async (_input, init) => {
      payload = JSON.parse(init.body);
      return new Response(body(encode(events)));
    },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(frames(emitted), ["noisy", "Hello 世界", "Hello 🌍"]);
  assert.deepEqual(committed(emitted), ["Hello 🌍"]);
  assert.deepEqual(result.content, [{ type: "text", text: "Hello 🌍" }]);
  assert.ok(emitted.findIndex((e) => e.type === "start") < emitted.findIndex((e) => e.delta === ""));
  assert.ok(
    emitted.every(
      (e) =>
        e.type !== "text_delta" || e.delta !== "" || e.partial.content.filter((b) => b.type === "text").length === 1,
    ),
  );
  assert.deepEqual(raw, events);
  assert.equal(result.usage.totalTokens, 110);
  assert.ok(result.usage.cost.total > 0);
  assert.equal(payload.diffusing, true);
  assert.equal(payload.store, undefined);
});

test("repeated finish_reason and a finish without content are tolerated", async () => {
  const repeated = await run(createInceptionStream(streamSimple), [
    chunk("a"),
    chunk("ab", "stop"),
    finish,
    finish,
    usage,
  ]);
  assert.equal(repeated.result.stopReason, "stop", repeated.result.errorMessage);
  assert.deepEqual(text(repeated.result), ["ab"]);
  const separate = await run(createInceptionStream(streamSimple), [chunk("a"), chunk("ab"), finish, usage]);
  assert.equal(separate.result.stopReason, "stop", separate.result.errorMessage);
  assert.deepEqual(text(separate.result), ["ab"]);
  assert.equal(separate.result.usage.totalTokens, 110);
});

test("empty final frame commits nothing", async () => {
  const { emitted, result } = await run(createInceptionStream(streamSimple), [chunk("noise"), chunk("", "stop")]);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(text(result), []);
  assert.deepEqual(frames(emitted), ["noise", ""]);
});

test("malformed, truncated and failed responses error without committing noise", async () => {
  for (const events of ["data: {oops}\n\n", [chunk("noise")]]) {
    const { result } = await run(createInceptionStream(streamSimple), events);
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage);
    assert.deepEqual(text(result), []);
  }
  const { result } = await run(createInceptionStream(streamSimple), [], {
    fetch: async () => new Response(JSON.stringify({ error: { message: "context_length_exceeded" } }), { status: 400 }),
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /context_length_exceeded/);
});

test("tool deltas pass through without duplication", async () => {
  const tool = {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const { result } = await run(createInceptionStream(streamSimple), [tool]);
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.deepEqual(result.content, [
    { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
  ]);
});

test("frames are paced, pacing can be disabled, and aborting ends any hold", async () => {
  const events = [chunk("a"), chunk("ab"), chunk("abc"), chunk("abcd", "stop")];
  const paced = await run(
    createInceptionStream(streamSimple, () => 30),
    events,
  );
  assert.ok(paced.elapsed >= 85, `paced run took ${paced.elapsed}ms`);
  assert.deepEqual(text(paced.result), ["abcd"]);
  const unpaced = await run(
    createInceptionStream(streamSimple, () => 0),
    events,
  );
  assert.ok(unpaced.elapsed < 60, `unpaced run took ${unpaced.elapsed}ms`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const aborted = await run(
    createInceptionStream(streamSimple, () => 1000),
    events,
    { signal: controller.signal },
  );
  assert.equal(aborted.result.stopReason, "aborted");
  assert.ok(aborted.elapsed < 500, `aborted run took ${aborted.elapsed}ms`);
});

test("terminal controls are stripped from frames but the committed text stays verbatim", async () => {
  const { emitted, result } = await run(createInceptionStream(streamSimple), [
    chunk("a\x1b[31mb\tc"),
    chunk("a\x1b[31mb\tc", "stop"),
  ]);
  assert.deepEqual(frames(emitted), ["a[31mb\tc", "a[31mb\tc"]);
  assert.deepEqual(text(result), ["a\x1b[31mb\tc"]);
});

test("registers Pi's built-in API-key login and pauses pacing outside interactive sessions", async () => {
  assert.equal(config.name, "Inception");
  assert.equal(config.apiKey, "$INCEPTION_API_KEY");
  assert.equal(config.oauth, undefined);
  assert.equal(config.models[0].id, "mercury-3");
  process.env.INCEPTION_DIFFUSION_FRAME_MS = "40";
  try {
    const registration = load();
    const events = [chunk("a"), chunk("ab"), chunk("abc"), chunk("abcd", "stop")];
    registration.handlers.session_start({ type: "session_start" }, { hasUI: false });
    const headless = await run(registration.config.streamSimple, events);
    assert.ok(headless.elapsed < 60, `headless run took ${headless.elapsed}ms`);
    registration.handlers.session_start({ type: "session_start" }, { hasUI: true });
    const interactive = await run(registration.config.streamSimple, events);
    assert.ok(interactive.elapsed >= 110, `interactive run took ${interactive.elapsed}ms`);
    assert.deepEqual(text(interactive.result), ["abcd"]);
  } finally {
    delete process.env.INCEPTION_DIFFUSION_FRAME_MS;
  }
});

test("several SSE events in one read, with keep-alive comments, parse individually", async () => {
  const events = [chunk("noisy"), chunk("Hello 世界"), chunk("Hello 🌍", "stop"), finish, usage];
  const crlf = ": keep-alive\n\n" + encode(events);
  for (const sse of [crlf, crlf.replaceAll("\r\n", "\n")]) {
    const raw = [];
    const { emitted, result } = await run(createInceptionStream(streamSimple), events, {
      onProviderStreamEvent(value) {
        raw.push(value);
      },
      fetch: async () => new Response(whole(sse)),
    });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(frames(emitted), ["noisy", "Hello 世界", "Hello 🌍"]);
    assert.deepEqual(committed(emitted), ["Hello 🌍"]);
    assert.deepEqual(raw, events);
    assert.equal(result.usage.totalTokens, 110);
  }
});

test("SSE data lines join across JSON tokens but raw newlines inside strings error", async () => {
  const valid =
    'data: {"choices":[{"index":0,\ndata: "delta":{"content":"ab"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const parsed = await run(createInceptionStream(streamSimple), valid);
  assert.equal(parsed.result.stopReason, "stop", parsed.result.errorMessage);
  assert.deepEqual(frames(parsed.emitted), ["ab"]);
  assert.deepEqual(text(parsed.result), ["ab"]);

  const invalid =
    'data: {"choices":[{"index":0,"delta":{"content":"a\ndata: b"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const failed = await run(createInceptionStream(streamSimple), invalid);
  assert.equal(failed.result.stopReason, "error");
  assert.deepEqual(text(failed.result), []);
});

test("the total hold per response is capped and configurable", async () => {
  const events = [chunk("a"), chunk("ab"), chunk("abc"), chunk("abcd", "stop")];
  const capped = await run(
    createInceptionStream(
      streamSimple,
      () => 200,
      () => 150,
    ),
    events,
  );
  assert.ok(capped.elapsed >= 140 && capped.elapsed < 400, `capped run took ${capped.elapsed}ms`);
  assert.deepEqual(text(capped.result), ["abcd"]);

  const disabled = await run(
    createInceptionStream(
      streamSimple,
      () => 1000,
      () => 0,
    ),
    events,
  );
  assert.ok(disabled.elapsed < 200, `uncapped run took ${disabled.elapsed}ms`);
});

test("INCEPTION_DIFFUSION_MAX_HOLD_MS is read at session start and invalid values fall back", async () => {
  process.env.INCEPTION_DIFFUSION_FRAME_MS = "100";
  process.env.INCEPTION_DIFFUSION_MAX_HOLD_MS = "120";
  try {
    const registration = load();
    const events = [chunk("a"), chunk("ab"), chunk("abc"), chunk("abcd", "stop")];
    await registration.handlers.session_start({ type: "session_start" }, { hasUI: true });
    const capped = await run(registration.config.streamSimple, events);
    assert.ok(capped.elapsed >= 110 && capped.elapsed < 250, `configured cap took ${capped.elapsed}ms`);

    process.env.INCEPTION_DIFFUSION_MAX_HOLD_MS = "nope";
    await registration.handlers.session_start({ type: "session_start" }, { hasUI: true });
    const fallback = await run(registration.config.streamSimple, events);
    assert.ok(fallback.elapsed >= 290, `default cap run took ${fallback.elapsed}ms`);
  } finally {
    delete process.env.INCEPTION_DIFFUSION_FRAME_MS;
    delete process.env.INCEPTION_DIFFUSION_MAX_HOLD_MS;
  }
});

test("warns at interactive session start when Mercury 3 has no API key", async () => {
  const registration = load();
  const notes = [];
  const lookups = [];
  const sessionContext = (provider, hasUI = true, key) => ({
    hasUI,
    model: { provider, id: "mercury-3" },
    modelRegistry: {
      async getApiKeyForProvider(id) {
        lookups.push(id);
        return key;
      },
    },
    ui: {
      notify(message, type) {
        notes.push({ message, type });
      },
    },
  });

  await registration.handlers.session_start({ type: "session_start" }, sessionContext("inception"));
  await registration.handlers.session_start(
    { type: "session_start" },
    sessionContext("inception", true, "configured-key"),
  );
  await registration.handlers.session_start({ type: "session_start" }, sessionContext("openai"));
  await registration.handlers.session_start({ type: "session_start" }, sessionContext("inception", false));

  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "warning");
  assert.match(notes[0].message, /\/login inception/);
  assert.match(notes[0].message, /INCEPTION_API_KEY/);
  assert.deepEqual(lookups, ["inception", "inception"]);
});

test("responses without a body error without committing noise", async () => {
  const failed = await run(createInceptionStream(streamSimple), [], {
    fetch: async () => new Response(null, { status: 503 }),
  });
  assert.equal(failed.result.stopReason, "error");
  assert.match(failed.result.errorMessage, /503/);
  assert.deepEqual(text(failed.result), []);

  const empty = await run(createInceptionStream(streamSimple), [], { fetch: async () => new Response(null) });
  assert.equal(empty.result.stopReason, "error");
  assert.match(empty.result.errorMessage, /no body/);
  assert.deepEqual(frames(empty.emitted), []);
  assert.deepEqual(text(empty.result), []);
});

test("a signal aborted before the request ends it without frames or holds", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = [chunk("a"), chunk("ab", "stop")];
  const { emitted, result, elapsed } = await run(
    createInceptionStream(streamSimple, () => 1000),
    events,
    {
      signal: controller.signal,
    },
  );
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(frames(emitted), []);
  assert.deepEqual(text(result), []);
  assert.ok(elapsed < 500, `pre-aborted run took ${elapsed}ms`);
});

test("a final event without a trailing blank line still parses", async () => {
  const sse = encode([chunk("a"), chunk("ab", "stop")]);
  // The body ends right after its last record, with and without [DONE].
  for (const unterminated of [sse.trimEnd(), sse.slice(0, sse.lastIndexOf("data: [DONE]")).trimEnd()]) {
    const { emitted, result } = await run(createInceptionStream(streamSimple), unterminated);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(frames(emitted), ["a", "ab"]);
    assert.deepEqual(text(result), ["ab"]);
  }
});

test("the global fetch is wrapped when no fetch is passed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body(encode([chunk("a"), chunk("ab", "stop")])));
  try {
    const { emitted, result } = await run(createInceptionStream(streamSimple), [], { fetch: undefined });
    assert.deepEqual(frames(emitted), ["a", "ab"]);
    assert.deepEqual(text(result), ["ab"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a transport that throws mid-stream still ends the response with an error", async () => {
  async function* failing() {
    yield { type: "start", partial: { role: "assistant", content: [] } };
    throw new Error("transport failed");
  }
  const { emitted, result } = await run(createInceptionStream(failing), []);
  assert.deepEqual(
    emitted.map((e) => e.type),
    ["start", "error"],
  );
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "transport failed");
  assert.equal(result.provider, "inception");
  assert.equal(result.model, "mercury-3");
  assert.deepEqual(result.content, []);
});
