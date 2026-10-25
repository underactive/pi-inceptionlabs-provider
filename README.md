# Inception for Pi

Adds Inception's `mercury-3` diffusion model to Pi. While a response streams,
the assistant message shows the answer resolving out of noise instead of
growing token by token.

![Mercury 3 resolving a response out of noise](https://raw.githubusercontent.com/underactive/pi-inceptionlabs-provider/main/assets/mercury_diffusion_llm.gif)

*Slowed down ~5x to show the denoising effect.*

Requires Pi 1.4.0 or newer and Node 22.19+.

## Setup

### 1. Get an API key

Create an account at [platform.inceptionlabs.ai](https://platform.inceptionlabs.ai)
and generate a key under
[Dashboard > API Keys](https://platform.inceptionlabs.ai/dashboard/api-keys).

### 2. Install the package

```sh
pi install npm:@underactive/pi-inceptionlabs-provider
```

This adds the package to `~/.pi/agent/settings.json`. Add `--local` to install
it only for the current project (`.pi/settings.json`). To try it for one session
without installing:

```sh
pi -e npm:@underactive/pi-inceptionlabs-provider
```

### 3. Add your key

In Pi, run:

```
/login inception
```

Pi prompts for the key and stores it in `~/.pi/agent/auth.json`, scoped to the
`inception` provider. It is kept separate from your other provider credentials.

Or set it in your environment before starting Pi:

```sh
export INCEPTION_API_KEY="your-key"
```

### 4. Select the model

Pick **Mercury 3 (Diffusion)** with `/model`, or start with it directly:

```sh
pi --model inception/mercury-3
```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `INCEPTION_API_KEY` | none | API key, if not set with `/login inception` |
| `INCEPTION_DIFFUSION_FRAME_MS` | `60` | Minimum time each diffusion frame stays on screen; `0` disables pacing |

## Update and remove

```sh
pi update --extensions
pi remove npm:@underactive/pi-inceptionlabs-provider
```

## Diffusion playback

Requests set `stream: true` and `diffusing: true`. Each frame Inception sends is
the complete answer so far, with regions that are still being decoded shown as
noise. The extension writes each frame into the streaming assistant message,
replacing the previous frame, so the transcript shows the answer resolving from
noise instead of growing token by token.

Inception emits frames in bursts: several frames per decoded block arrive in the
same millisecond, and short answers arrive all at once. Rendered at network speed
the noisy frames would be invisible, so each frame is held on screen for at least
60 ms. Set `INCEPTION_DIFFUSION_FRAME_MS` to change the hold (0 disables it).
Holds total at most 2 s per response, after which frames show at network speed.
Pacing is skipped in print and JSON mode, where nothing is rendered.

Only the final frame is committed: intermediate frames never enter the session
file, conversation history, or model context. Extension hooks see the raw
provider events; `provider_stream_event` receives every original frame. Tool
calls, usage, and errors use Pi's normal OpenAI transport, including retries
and cancellation. Cancelling a response ends any pending hold immediately.

Mercury 3 supports text input and tool calling. Pi thinking levels map to
Inception's instant/low/medium/high reasoning efforts. In diffusing mode the API
does not stream reasoning, so higher levels add silent delay before the first
frame. Registered prices are the documented launch rates ($0.10 input, $0.01
cached input, $0.35 output per million tokens); these are estimates and can
change. Other Mercury models and non-chat endpoints are not registered.

## Development

To run a local checkout instead of the published package:

```sh
pi -e /absolute/path/to/pi-inceptionlabs-provider/index.js
```

Inside Pi the extension needs no installed dependencies: it imports only module
specifiers Pi resolves for extensions. The tests run outside Pi, so
`@earendil-works/pi-ai` must be resolvable locally (install it, or link your Pi
installation's node_modules for development), then run:

```sh
npm test
```

Tests use mocked HTTP streams: byte-split Unicode and SSE framing, frame
replacement, repeated and content-less finish chunks, empty output, raw event
instrumentation, tool calls, usage, malformed and truncated streams, HTTP errors,
pacing, aborts, and control-character stripping. No API credentials are required.

## Sources

- [Streaming and diffusion](https://docs.inceptionlabs.ai/capabilities/streaming)
- [Model capabilities and pricing](https://docs.inceptionlabs.ai/get-started/models)

## License

MIT
