// Pi resolves only a few module specifiers for extensions; the compat entry is one of them.
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createInceptionStream, DEFAULT_MAX_HOLD_MS } from "./diffusion.js";

const DEFAULT_FRAME_MS = 60;

// Read a non-negative integer millisecond value, or use its default.
function readMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export default function inception(pi) {
  // Minimum time each diffusion frame stays on screen. 0 disables pacing.
  let frameMs = readMs("INCEPTION_DIFFUSION_FRAME_MS", DEFAULT_FRAME_MS);
  // Maximum total hold per response. 0 disables pacing.
  let maxHoldMs = readMs("INCEPTION_DIFFUSION_MAX_HOLD_MS", DEFAULT_MAX_HOLD_MS);
  pi.registerProvider("inception", {
    name: "Inception",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    apiKey: "$INCEPTION_API_KEY",
    api: "inception-diffusion",
    streamSimple: createInceptionStream(openAICompletionsApi().streamSimple, () => frameMs, () => maxHoldMs),
    models: [{
      id: "mercury-3",
      name: "Mercury 3 (Diffusion)",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0.1, output: 0.35, cacheRead: 0.01, cacheWrite: 0 },
      thinkingLevelMap: { off: "instant", minimal: "instant", low: "low", medium: "medium", high: "high", xhigh: "high" },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" },
    }],
  });
  pi.on("session_start", async (_event, ctx) => {
    // Nobody watches frames in print or JSON mode, so do not hold the response there.
    frameMs = ctx.hasUI ? readMs("INCEPTION_DIFFUSION_FRAME_MS", DEFAULT_FRAME_MS) : 0;
    maxHoldMs = readMs("INCEPTION_DIFFUSION_MAX_HOLD_MS", DEFAULT_MAX_HOLD_MS);
    // Pi rejects the first prompt without a key; say so before the user types it.
    if (!ctx.hasUI || ctx.model?.provider !== "inception") return;
    if (!(await ctx.modelRegistry.getApiKeyForProvider("inception"))) {
      ctx.ui.notify("No Inception API key. Run /login inception or set INCEPTION_API_KEY.", "warning");
    }
  });
}
