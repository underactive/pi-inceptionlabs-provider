// Pi resolves only a few module specifiers for extensions; the compat entry is one of them.
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createInceptionStream } from "./diffusion.js";

const DEFAULT_FRAME_MS = 60;

// Minimum time each diffusion frame stays on screen. 0 disables pacing.
function readFrameMs() {
  const value = Number(process.env.INCEPTION_DIFFUSION_FRAME_MS);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_FRAME_MS;
}

export default function inception(pi) {
  let frameMs = readFrameMs();
  pi.registerProvider("inception", {
    name: "Inception",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    apiKey: "$INCEPTION_API_KEY",
    api: "inception-diffusion",
    streamSimple: createInceptionStream(openAICompletionsApi().streamSimple, () => frameMs),
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
  // Nobody watches frames in print or JSON mode, so do not hold the response there.
  pi.on("session_start", (_event, ctx) => {
    frameMs = ctx.hasUI ? readFrameMs() : 0;
  });
}
