# Changelog

## [Unreleased]

### Added

- `INCEPTION_DIFFUSION_MAX_HOLD_MS` sets the total time frames may be held per response (default `2000`; `0` disables holds).
- Warning at interactive session start when Mercury 3 is selected without an Inception API key.
- CI runs the tests on Node 22.19, 22, 24 and 26.

### Changed

- `@earendil-works/pi-ai` peer dependency narrowed from `*` to `>=1.4.0`, the documented minimum Pi version.
- `npm install && npm test` works on a fresh clone; `@earendil-works/pi-ai` is now a dev dependency.

## [0.1.0] - 2026-10-26

### Added

- Inception `mercury-3` provider for Pi.
- Diffusion rendering that shows the streamed answer resolving out of noise.
- Thinking level mapping to Mercury `reasoning_effort` (`instant`, `low`, `medium`, `high`).
