# Decisions

Choices made while building Gloss, and why. Newest phase last. Where the docs
and `PLAN.md` disagree, the docs win and the difference is noted here.

## Phase 0 — spikes

**Status: spikes written, none of the three has been run against the real thing yet.**
They were written in a cloud Linux container with no audio hardware, no API
keys, and no network route to `soniox.com`, `api.soniox.com`, `electronjs.org`
or GitHub release downloads (so the Electron binary itself could not be
installed there). What was checked there: `tsc --noEmit` passes, the DSP unit
tests pass, every script parses and fails cleanly without keys. The exit
criteria in PLAN §10 are still open and need the owner's machine.

| Exit criterion | State |
|---|---|
| System audio verified non-silent (S1) | not run — needs the owner's machine |
| Hebrew/English transcript usable (S2) | not run — needs `SONIOX_API_KEY` and a real recording |
| End-to-end budget achievable (S3) | not run — needs `ANTHROPIC_API_KEY` |

### Docs consulted

| API | Source | Result |
|---|---|---|
| Electron 45.3.0 | `docs/api/session.md`, `desktop-capturer.md`, `browser-window.md` from the electron repo (main), plus `electron.d.ts` of the installed package | read |
| Anthropic TypeScript SDK 1.8.0 | SDK reference bundled with Claude Code (models cached 2026-11-03) | read |
| Soniox real-time WebSocket | soniox.com | **unreachable — not read** |

### Electron (verified against docs)

- `session.setDisplayMediaRequestHandler` with `audio: 'loopback'` is the
  system-audio route; supported on **Windows and macOS 14.2+**. Not Linux.
- macOS: since Electron 39 Chromium uses the CoreAudio Tap API, with **no
  fallback** to the ScreenCaptureKit path, and as of Electron 45 the feature
  flag to opt back is gone. So macOS < 14.2 has no loopback at all in this
  Electron; those machines need the virtual-device fallback.
- macOS: `NSAudioCaptureUsageDescription` must be in Info.plist. **Unpackaged
  (`npm run …` from a terminal), the permission belongs to the terminal/IDE**,
  not to Electron. Expect S1 to show silence until the terminal is allowed
  under "System Audio Recording Only".
- macOS: when the permission is missing the audio track **is still created,
  already in the `ended` state, and no error reaches JavaScript**. The
  silent-track guard therefore checks both "no frames ever arrived" and
  "frames are exact digital zero", and S1 logs `track.readyState`.
- `win.setContentProtection(true)`: on Windows 10 2004+ the window is removed
  from capture. **On macOS the docs say ScreenCaptureKit captures the window
  anyway.** PLAN §6.1/§13 ("invisible to screen share") cannot be promised on
  macOS from this API alone — to be tested against real Zoom/Teams in Phase 1,
  and reported to the owner before the panel is relied on.
- Linux: `getDisplayMedia` goes through the PipeWire picker and gives no
  loopback audio; S1 offers the input-device picker (monitor source) instead.

### Claude (verified against the SDK reference)

- Stage B model: **`claude-haiku-5-5`** (the current Haiku; 1M context,
  $0.10 / $0.50 per MTok under 100K-token prompts). Overridable in the spike
  with `GLOSS_FAST_MODEL`.
- Haiku 5.5 **thinks by default** (adaptive, effort `medium`). For the 2 s
  budget S3 measures `thinking: {type: "disabled"}` + `effort: "low"` against
  adaptive + `low`. Disabled thinking is only accepted at effort `high` or
  below. Pick from the measurements, not from this note.
- Structured output: `output_config.format` with `zodOutputFormat(schema)`
  (not tool use — forced `tool_choice` is rejected on several current models,
  and JSON output streams as plain text deltas, which is what progressive card
  rendering needs). Assistant prefill is rejected on current models.
- Schema differences from the PLAN §5.5 sketch: optional fields
  (`why_here`, `gotcha`) are `nullable` rather than optional, and length limits
  (≤14 words, ≤3 bullets) live in the prompt because structured outputs
  constrain shape, not length. zod still validates the final object.
- Sampling parameters (`temperature` etc.) are rejected at non-default values
  on Haiku 5.5; none are sent.
- Prompt caching: static system prompt with a `cache_control` breakpoint. There
  is a model-dependent minimum cacheable length; the spike prompt is likely
  under it. The Phase 2 prompt (rules + glossary list) will be longer —
  confirm with `usage.cache_read_input_tokens`.
- Stage C (Phase 3, recorded now so it is not re-researched): server tool
  `{type: "web_search_20260209", name: "web_search"}`, on `claude-opus-5-5`.
  Web-search errors come back as a 200 with an error object, not an exception.
  Opus 5.5 can return `stop_reason: "refusal"`; handle it.

### Soniox (NOT verified — from memory)

Everything below is unconfirmed and must be checked against the docs before
S2's output is trusted. All of it is overridable by env var in the spike.

- Endpoint `wss://stt-rt.soniox.com/transcribe-websocket` (`SONIOX_WS_URL`).
- Model id defaults to `stt-rt-preview` (`SONIOX_MODEL`). PLAN says v5 is
  current; the exact id is unknown.
- Start message: JSON with `api_key`, `model`, `audio_format: "pcm_s16le"`,
  `sample_rate`, `num_channels`, `language_hints`,
  `enable_language_identification`, `enable_endpoint_detection`, `context`.
- `context` is sent as `{ terms: [...] }`; older models took a plain string.
- Binary frames carry audio; an empty frame ends the stream; the endpoint
  arrives as a token with text `<end>`.
- Still unknown: max session length and rollover, keepalive message.

### Other choices

- Spike DSP lives in one dependency-free ES module (`spikes/s1-audio/pcm-core.js`)
  imported by both the AudioWorklet and the unit tests, so the tests exercise
  the code that actually runs. Phase 1 moves it to `src/renderer/capture/`.
- Downsampling uses a box-filter average (cheap anti-alias), not a proper
  low-pass. Adequate for speech going into STT; revisit only if S2 shows it
  hurting accuracy.
- Root package is ESM (`"type": "module"`); Electron main and the sandboxed
  preload are `.cjs` (a sandboxed preload cannot be ESM).
- WAV fixtures are git-ignored: real call audio does not go in the repo.

## Repo housekeeping

- This repository previously held an unrelated app and was cleared. It is
  still connected to a Vercel project that will fail on every push — Gloss is
  a desktop app with nothing to deploy. Disconnect it in Vercel.
