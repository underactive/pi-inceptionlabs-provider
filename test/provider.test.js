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
    registerProvider(name, config) { assert.equal(name, "inception"); registration.config = config; },
    on(event, handler) { registration.handlers[event] = handler; },
  });
  return registration;
}

const { config } = load();
const model = { ...config.models[0], provider: "inception", api: config.api, baseUrl: config.baseUrl };
const context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
const chunk = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
const encode = (events) => events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
function body(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    // Deliberately split UTF-8 characters and SSE delimiters across reads.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
}
async function run(stream, events, extra = {}) {
  const started = performance.now();
  const s = stream(model, context, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => new Response(typeof events === "string" ? body(events) : body(encode(events))),
    ...extra,
  });
  const emitted = [];
  for await (const event of s) emitted.push(event);
  return { emitted, result: await s.result(), elapsed: performance.now() - started };
}
// Synthetic frame events carry an empty delta and the frame as the trailing text block.
const frames = (emitted) => emitted.filter((e) => e.type === "text_delta" && e.delta === "").map((e) => e.partial.content.at(-1).text);
const committed = (emitted) => emitted.filter((e) => e.type === "text_delta" && e.delta !== "").map((e) => e.delta);
const text = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text);

test("frames overwrite the streaming message and only the final text is committed", async () => {
  const raw = [];
  let payload;
  const events = [chunk("noisy"), chunk("Hello 世界"), chunk("Hello 🌍", "stop"), finish, usage];
  const { emitted, result } = await run(createInceptionStream(streamSimple), events, {
    onPayload(value) { assert.equal(value.diffusing, true); return value; },
    onProviderStreamEvent(value) { raw.push(value); },
    fetch: async (_input, init) => { payload = JSON.parse(init.body); return new Response(body(encode(events))); },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(frames(emitted), ["noisy", "Hello 世界", "Hello 🌍"]);
  assert.deepEqual(committed(emitted), ["Hello 🌍"]);
  assert.deepEqual(result.content, [{ type: "text", text: "Hello 🌍" }]);
  assert.ok(emitted.findIndex((e) => e.type === "start") < emitted.findIndex((e) => e.delta === ""));
  assert.ok(emitted.every((e) => e.type !== "text_delta" || e.delta !== "" || e.partial.content.filter((b) => b.type === "text").length === 1));
  assert.deepEqual(raw, events);
  assert.equal(result.usage.totalTokens, 110);
  assert.ok(result.usage.cost.total > 0);
  assert.equal(payload.diffusing, true);
  assert.equal(payload.store, undefined);
});

test("repeated finish_reason and a finish without content are tolerated", async () => {
  const repeated = await run(createInceptionStream(streamSimple), [chunk("a"), chunk("ab", "stop"), finish, finish, usage]);
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
  const tool = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] }, finish_reason: "tool_calls" }] };
  const { result } = await run(createInceptionStream(streamSimple), [tool]);
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.deepEqual(result.content, [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }]);
});

test("frames are paced, pacing can be disabled, and aborting ends any hold", async () => {
  const events = [chunk("a"), chunk("ab"), chunk("abc"), chunk("abcd", "stop")];
  const paced = await run(createInceptionStream(streamSimple, () => 30), events);
  assert.ok(paced.elapsed >= 85, `paced run took ${paced.elapsed}ms`);
  assert.deepEqual(text(paced.result), ["abcd"]);
  const unpaced = await run(createInceptionStream(streamSimple, () => 0), events);
  assert.ok(unpaced.elapsed < 60, `unpaced run took ${unpaced.elapsed}ms`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const aborted = await run(createInceptionStream(streamSimple, () => 1000), events, { signal: controller.signal });
  assert.equal(aborted.result.stopReason, "aborted");
  assert.ok(aborted.elapsed < 500, `aborted run took ${aborted.elapsed}ms`);
});

test("terminal controls are stripped from frames but the committed text stays verbatim", async () => {
  const { emitted, result } = await run(createInceptionStream(streamSimple), [chunk("a\x1b[31mb\tc"), chunk("a\x1b[31mb\tc", "stop")]);
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
