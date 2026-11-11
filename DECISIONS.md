# Decisions

Choices made while building Gloss, and why. Where the docs and `PLAN.md`
disagree, the docs win and the difference is noted here.

## 2026-11-11 — Gloss moves from a desktop app to the iPhone

The owner asked for Gloss to run on his iPhone 15 Pro itself. `PLAN.md` was
revised; the original Electron plan and its capture spike are in git history
(commit `ad5f5fc`).

**It is a web app in Safari, not a native iOS app.** A native app needs a Mac,
Xcode, an Apple developer account and App Store or TestFlight distribution, and
cannot be built or tested from here at all. A web app is a URL he opens.
Safari gives Gloss everything it needs: microphone, AudioWorklet, WebSocket,
Screen Wake Lock, IndexedDB.

What this costs, stated plainly because each one changes the product:

- **The phone only hears what is in the room.** iOS does not let an app capture
  another app's audio. The customer's voice must come out of a speaker. With
  headphones Gloss hears only the owner. A call taken on the iPhone itself is
  not supported.
- **No separate "me" and "them" streams.** One microphone. Speaker labels come
  from Soniox diarization and are best-effort.
- **It stops when the page is not in front.** Safari suspends the microphone
  when the page is hidden or the screen locks. A wake lock keeps the screen on;
  switching apps pauses listening.
- **Transcription quality depends on where the phone sits.** Far-field audio
  from a laptop speaker is harder than a direct system-audio feed. This is the
  main thing Phase 0 has to answer on the real device.
- **Dropped:** system-audio loopback, the second-screen window, hiding from
  screen share (nothing is on the shared screen any more), global hotkeys,
  SQLite, OS keychain storage.

**No backend, so the long-lived API keys live in the browser.** Soniox's docs
say not to put a long-lived key in a client and to mint temporary keys from a
backend. The plan forbids a backend, and here the "client" is the account
owner's own phone holding his own key, typed in by him — the same trust as a
`.env` file on his laptop. Mitigations: keys are never in the repo, the build
or a URL; a strict Content-Security-Policy allows scripts only from the site
itself and connections only to `api.anthropic.com` and `stt-rt.soniox.com`.
This does not stretch to other users: productization needs a key-minting
backend (PLAN §12).

**Hosting: Vercel**, on the project that was already linked to this repo.
`vercel.json` sets the Vite build and the security headers. The page is public
but holds no secrets and is marked `noindex`.

## Phase 0 — check page

**Status: written, deployed, and verified in headless Chromium only.** The
exit criteria need the owner's iPhone and his two keys.

| Exit criterion | State |
|---|---|
| Phone hears a laptop speaker well enough (S1) | not run on the phone |
| Hebrew/English transcript usable (S2) | not run — needs `SONIOX_API_KEY` |
| End-to-end budget achievable (S3) | not run — needs `ANTHROPIC_API_KEY` |

Verified here, in Chromium at iPhone 15 Pro viewport with a fake microphone,
served with the production CSP headers: the worklet loads and runs, the meter
moves, a 5 s recording plays back, keys persist across reload, and a missing
key, a failed Soniox connection and a failed Anthropic connection each produce
a readable message. **Not verified: anything in real Safari on iOS**, and any
real call to Soniox or Anthropic (both hosts are unreachable from the build
environment).

### Docs consulted

| API | Source | Result |
|---|---|---|
| Soniox real-time STT | docs.soniox.com: WebSocket API reference, WebSocket authentication, real-time transcription, endpoint detection, keepalive, limits, error handling, context, models, speaker diarization | read 2026-11-11 |
| Anthropic TypeScript SDK 1.8.0 | SDK reference bundled with Claude Code (models cached 2026-11-03) | read |
| iOS Safari capture behaviour | — | **not read from a primary source**; the iOS notes below are from memory and are exactly what the phone check exists to confirm |

### Soniox (verified against docs)

An earlier version of this file listed Soniox details from memory. Reading the
docs corrected four of them: the model id, how the key is sent, how the stream
is ended, and the keepalive message.

- Endpoint `wss://stt-rt.soniox.com/transcribe-websocket`.
- Model **`stt-rt-v6`** (released 2026-11-03). `stt-rt-v5` is deprecated and
  removed on 2026-12-15. PLAN said v5.
- **Auth:** the key goes with the connection, not in the start message
  (`api_key` there is deprecated and refused from 2027-01-15). Browsers cannot
  set WebSocket headers, so it is passed as
  `new WebSocket(url, ['soniox-api-key', key])`. Node uses
  `Authorization: Bearer`.
- A bad key does **not** fail the handshake: the socket opens, then an error
  frame arrives and the server closes. So auth errors are read from
  `onmessage`, not `onerror`.
- Start message: `model`, `audio_format: "pcm_s16le"`, `sample_rate: 16000`,
  `num_channels: 1`, `language_hints: ["he","en"]`,
  `enable_language_identification`, `enable_endpoint_detection`,
  `enable_speaker_diarization`, `context`.
- `context` is an object: `general` (key/value pairs), `text`, `terms`,
  `translation_terms`. Limit 8,000 tokens (~10,000 characters) — the glossary
  (~80 terms + aliases) fits; a long pasted brief may need trimming.
- Audio is sent as binary frames, in real time. **An empty text frame ends the
  stream**; an empty binary frame does not.
- Tokens: `text`, `is_final`, `confidence`, `start_ms`, `end_ms`, optional
  `language`, optional `speaker`. The endpoint is a final token with text
  `<end>`.
- Endpoint tuning exists (`max_endpoint_delay_ms` 500–3000, default 2000;
  `endpoint_sensitivity`; `endpoint_latency_adjustment_level` 0–3). The default
  2 s maximum delay alone could consume the whole latency budget — tune from
  the `endpoint delayMs` values the check page logs.
- Keepalive: `{"type":"keepalive"}` at least every 20 s when no audio is being
  sent (needed for pause). Without it the stream ends with 408.
- Errors: a JSON frame with `error_code`, `error_type`, `error_message`,
  `request_id`, then close. Branch on `error_type`. 503 means restart the
  stream; 1006 with no close frame means reconnect.
- Stream cap: 300 minutes, fixed. A 413 `max_duration_reached` means open a
  new one. Billing is for stream duration, not audio processed, so pause
  should close the stream rather than idle on keepalives for long.
- Hebrew (`he`) is a supported language.

### Claude (verified against the SDK reference)

- Stage B model: **`claude-haiku-5-5`** ($0.10 / $0.50 per MTok under
  100K-token prompts).
- Haiku 5.5 thinks by default (adaptive, effort `medium`). The check page
  measures `thinking: {type: "disabled"}` + `effort: "low"` against adaptive +
  `low`; choose from the measurements. Disabled thinking is only accepted at
  effort `high` or below.
- Structured output: `output_config.format` with `zodOutputFormat(schema)`,
  streamed. Not tool use — forced `tool_choice` is rejected on several current
  models, and JSON output streams as text deltas, which is what progressive
  card rendering needs. Assistant prefill is rejected.
- Schema differences from the PLAN §5.5 sketch: `why_here` and `gotcha` are
  nullable rather than optional; length limits live in the prompt because
  structured outputs constrain shape, not length.
- Browser use: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
- Sampling parameters are rejected at non-default values on Haiku 5.5; none
  are sent.
- Prompt caching: static system prompt with a `cache_control` breakpoint. The
  spike prompt is likely under the minimum cacheable length; the page logs
  `cacheRead` so this is visible.
- Stage C (Phase 3): server tool `{type: "web_search_20260209", name:
  "web_search"}` on `claude-opus-5-5`. Web-search errors arrive as a 200 with an
  error object. Opus 5.5 can return `stop_reason: "refusal"`; handle it.

### iOS Safari (from memory — to be confirmed on the phone)

- `AudioContext` must be created or resumed inside a user gesture.
- Hardware sample rate is 48 kHz; the worklet resamples to 16 kHz.
- The worklet is routed to the output through a zero-gain node, because some
  browsers do not run a worklet that leads nowhere.
- The page loses the microphone when hidden. The page logs every
  `visibilitychange` with the context and track state so the real behaviour is
  recorded.
- Screen Wake Lock is available in Safari 16.4+.

### Other choices

- The DSP is one dependency-free ES module (`pcm-core.js`) used by both the
  worklet and the unit tests.
- Downsampling uses a box-filter average, not a proper low-pass. Adequate for
  speech; revisit only if transcription suffers.
- Extraction prompt, schema and fixtures are shared between the phone page and
  the Node script (`spikes/shared/`), so a result on one is a result on both.
- WAV fixtures are git-ignored: real call audio does not go in the repo.
