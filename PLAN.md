# Gloss — live jargon explainer for meetings

**Build plan for Claude Code.** Working name "Gloss" (rename freely).

---

## 0. How to use this file (Claude Code: read this first)

1. Read the whole file before writing code.
2. Work phase by phase (section 10). Each phase ends in something runnable. **Stop at the end of every phase**, print the demo checklist, and wait for the owner to confirm before continuing.
3. **Do not trust your memory for third-party APIs.** Before writing integration code, fetch the current docs for: Soniox real-time WebSocket API, Electron `desktopCapturer` / `session.setDisplayMediaRequestHandler`, and the Anthropic TypeScript SDK (streaming, tool use / structured output, prompt caching, web search tool). Confirm model IDs, parameter names and limits there. Where this plan and the docs disagree, the docs win; note the difference in `DECISIONS.md`.
4. Commit at the end of each phase with a clear message. Keep `DECISIONS.md` (choices made + why) and `README.md` (how to run) current.
5. Ask the owner only when blocked on something only he has (API keys, OS permission prompts, a product choice not covered here). Otherwise decide, record it, move on.
6. No scope creep: no backend server, no user accounts, no vector DB, no meeting bot that joins calls. See section 12.

---

## 1. The product in one paragraph

The owner is a Field Applications Engineer at an edge-AI company. In customer calls (Zoom / Teams) people throw around product names, model names, chips and acronyms he may not know yet. Gloss runs on his machine, listens to the call (his mic + the system audio), transcribes live, and on his **second screen** shows a calm stack of cards: what each technical term is, why it matters in this conversation, and **how the terms just mentioned fit together**. Nothing joins the meeting. Nobody else sees it.

Canonical example. Customer says (Hebrew with English terms): "on the SiMa dev board, the new Modalix, you need to run RF-DETR Nano". Within ~2 seconds the second screen shows:

- **SiMa.ai Modalix** — what it is, in one line, then 3 bullets.
- **RF-DETR Nano** — what it is, in one line, then 3 bullets.
- **How they connect** — 2 sentences on running that model on that board and what the usual friction points are.

## 2. Assumptions (change in `DECISIONS.md` if wrong)

- **Languages:** Hebrew conversation with English technical terms mixed in, sometimes fully English. Code-switching mid-sentence is the normal case, not an edge case.
- **OS:** unknown. Build cross-platform Electron; develop and verify on whatever machine this runs on first, keep the others working by design (section 5.1).
- **Scope:** single-user desktop tool first, built cleanly enough to productize later. API keys are the owner's own.
- **Keys needed from owner:** `SONIOX_API_KEY`, `ANTHROPIC_API_KEY`. Optional: `DEEPGRAM_API_KEY` (fallback STT).

## 3. Product principles (these decide every trade-off)

1. **Glanceable.** He is talking to a customer. A card must be understood in one glance: bold term, one-line answer, max 3 short bullets. Detail is behind a click.
2. **Fast.** Budget: speech end -> first card text visible in **under 2.0 s (p50), under 3.5 s (p95)**. Glossary hits in under 300 ms.
3. **Precision over recall.** A wrong or obvious card costs attention. Better to miss a term than to explain "API" to an engineer. Hard cap on card rate.
4. **Never repeat.** A term is explained once per meeting; "I know this" suppresses it forever.
5. **It learns.** Every meeting improves the local glossary, which improves both transcription and speed next time.
6. **Honest.** Low-confidence guesses are visibly marked. Web-verified facts carry a source link. Never present a guess as fact.
7. **Private by default.** No audio stored. Panel hidden from screen share. Clear on/off state.

## 4. Architecture

```
 mic ----------> AudioWorklet (16k PCM16) --\
                                             >-- IPC --> main process
 system audio -> AudioWorklet (16k PCM16) --/              |
 (loopback)                                                 v
                                             STT provider (Soniox WS) x2 streams
                                             tokens {text, is_final, language, speaker}
                                                            |
                                                            v
                                             Utterance assembler (per source: "me" / "them")
                                                            |
                              +-----------------------------+-----------------------+
                              v                                                     v
                 Stage A: local glossary matcher                  Stage B: LLM term extractor
                 (fuzzy + Hebrew-phonetic aliases)                (fast model, streaming JSON)
                 -> instant card from cache                       -> new cards + relations
                              |                                                     |
                              +---------------------> Card store <------------------+
                                                         |    ^
                                                         |    | Stage C: async grounding
                                                         |    | (web search, bigger model)
                                                         v    | -> verified facts + sources
                                              Renderer (second-screen panel)
                                                         |
                                              SQLite: sessions, transcript, cards, glossary
```

**Stack**

- Electron (latest stable) + electron-vite, TypeScript strict everywhere.
- Renderer: React + Tailwind + Zustand.
- Main: `ws` for STT sockets, `@anthropic-ai/sdk`, `better-sqlite3`, `zod` for all LLM/IPC payload validation.
- Tests: Vitest (unit), Playwright for Electron (smoke), custom replay + eval harness (section 9).
- Packaging: electron-builder.

Why Electron and not Tauri or a web app: Electron exposes system-audio loopback through `getDisplayMedia` on Windows and macOS without a virtual audio driver, and controls window placement and content protection. That is the riskiest part of the product, so pick the stack that makes it easiest.

**Process boundaries**

- All secrets, network calls, DB access live in **main**. Renderer gets a typed, minimal `contextBridge` API. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Audio capture must happen in a renderer (Web APIs). Use a hidden capture window or the panel renderer; send PCM frames to main over a `MessagePort` (transferable ArrayBuffers), not plain `ipcRenderer.send`.

## 5. Pipeline, in detail

### 5.1 Audio capture

Two independent sources, kept separate end to end (gives free "me" vs "them" attribution and better accuracy than a mix):

- **Mic:** `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`. Device selectable in settings.
- **System audio:**
  - **Windows / macOS:** in main, `session.setDisplayMediaRequestHandler((req, cb) => cb({ video: <first screen source>, audio: 'loopback' }))`; in renderer, `getDisplayMedia({ video: true, audio: true })`, then immediately stop the video track and keep the audio track.
  - **macOS specifics (verify in Electron docs for the installed version):** macOS 14.2+ needs `NSAudioCaptureUsageDescription` in Info.plist; recent Electron uses the CoreAudio Tap API by default. Handle the permission prompt and show a clear in-app message if capture returns silence.
  - **Linux:** loopback is not provided this way. Offer a device picker and document selecting the PulseAudio/PipeWire **monitor** source.
  - **Universal fallback:** setting "system audio = any input device", so a virtual device (BlackHole, VB-Cable, monitor source) always works.
- **Processing:** one `AudioWorkletProcessor` per source: downmix to mono, resample to 16 kHz, convert to PCM16 LE, emit ~100 ms frames. Compute RMS per frame for the level meters and for silence detection.
- **Silent-track guard:** if the system stream has RMS == 0 for 5 s while a call is evidently active, surface "No system audio detected" with the fix for that OS. This is the classic failure mode; do not ship without it.
- **Echo:** if he uses speakers, the mic hears the customer too. Mitigate with echo cancellation, recommend headphones in onboarding, and rely on term dedup so a doubled utterance never produces a doubled card.

### 5.2 Speech-to-text

Behind an interface so providers can be swapped:

```ts
interface SttProvider {
  start(opts: { source: 'me' | 'them'; languageHints: string[]; contextTerms: string[]; contextText?: string }): Promise<void>;
  pushAudio(pcm16: ArrayBuffer): void;
  onTokens(cb: (t: SttToken[]) => void): void;   // { text, isFinal, language?, speaker?, startMs, endMs }
  onEndpoint(cb: () => void): void;
  updateContext?(terms: string[]): void;
  stop(): Promise<void>;
}
```

- **Primary: Soniox real-time** (WebSocket). Reasons: real-time Hebrew, native Hebrew/English code-switching with per-token language tags, free-text/term **context** biasing for jargon, endpoint detection, very low cost. Config to verify in docs: latest real-time model id (v5 at time of writing), `language_hints: ["he","en"]`, `enable_language_identification: true`, `enable_endpoint_detection: true`, `context` built from glossary terms + the pre-meeting brief (section 6.5), raw PCM format fields, max session length and how to roll over.
- **Fallback: Deepgram Nova-3** (Hebrew supported, keyterm prompting, mid-stream keyterm updates). Implement second, only after the primary works. Check whether its multilingual mode covers Hebrew or whether Hebrew is monolingual-only; that decides if it is a real fallback for mixed speech.
- **Later, optional: local STT** (whisper.cpp with a Hebrew-tuned model) for confidential customers. Just keep the interface honest; do not build now.
- **Robustness:** auto-reconnect with backoff, buffer up to 10 s of audio during reconnect, session rollover before the provider's max duration, keepalive during silence. Never crash the meeting UI because a socket died; show a small "reconnecting" state.
- **Context is a first-class feature:** every glossary term (canonical + aliases) is fed to the STT as context. This is how "RF דיטר נאנו" becomes "RF-DETR Nano" at the source.

### 5.3 Utterance assembly

- Keep interim tokens only for the live ticker. Everything downstream uses **final** tokens.
- An utterance closes on provider endpoint, or after 4 s of accumulated final text without endpoint (long monologues), whichever comes first.
- Maintain a rolling window: last ~90 s of final transcript across both sources, labelled `me:` / `them:`, as LLM context.

### 5.4 Stage A — instant glossary match (no LLM)

- On every closed utterance, match against the local glossary: case-insensitive, punctuation-insensitive, fuzzy (token-level edit distance), plus **alias lists** that include Hebrew-letter phonetic spellings and common mis-hearings (e.g. `RF-DETR` <- `אר אף דיטר`, `RF detter`, `RFD TR`).
- A hit with a cached, already-verified explanation renders a card immediately (target < 300 ms).
- Respect suppression (known terms, already shown this session).

### 5.5 Stage B — LLM term extraction (the core)

- Model: the current fast Claude model (Haiku class; confirm exact id in docs). Streaming. Structured output via tool use / JSON schema validated with zod.
- One call per closed utterance, **debounced**: if a call is in flight, queue at most one follow-up containing everything new. Cancel stale calls.
- **Prompt layout (cache-friendly):**
  - System (static, cached): role, rules, output schema, owner profile ("experienced full-stack engineer, new to edge-AI hardware and CV model deployment; knows general software, networking, cloud, web"), domain description, glossary canonical list.
  - User (dynamic): meeting brief if any; rolling transcript window; the new utterance marked clearly; list of terms already shown or suppressed.
- **Rules to encode in the prompt:**
  - Extract only terms a senior software engineer who is new to this domain might not know: products, boards, chips, SDKs, model architectures, model variants, protocols, interfaces, file formats, metrics, domain acronyms, customer-internal names.
  - Skip general software vocabulary (API, Docker, latency, REST, GPU) unless used in a domain-specific sense.
  - **Repair transcription:** the transcript may garble terms, write English terms in Hebrew letters, or split them. Infer the canonical term from phonetics + domain + surrounding context. Return both `heard_as` and `canonical`.
  - Give a calibrated `confidence` (0-1) that the canonical identification is right, and a separate `knowledge` flag: `known` / `unsure` / `unknown`. If unknown, say so; do not invent specs, versions or numbers.
  - Explanation language follows the `explainLanguage` setting (`he` or `en`); the term itself always stays in its original script.
  - If two or more terms in the current window relate, emit a `relation` describing concretely how they work together and the typical gotcha.
  - Return an empty list when nothing qualifies. Empty is the common, correct answer.
- **Schema (sketch):**

```ts
type Extraction = {
  terms: Array<{
    canonical: string;            // "RF-DETR Nano"
    heard_as: string;             // "RF דיטר נאנו"
    kind: 'product'|'board'|'chip'|'sdk'|'model'|'protocol'|'interface'|'format'|'metric'|'concept'|'org'|'other';
    one_liner: string;            // <= 14 words
    bullets: string[];            // <= 3, <= 12 words each
    why_here?: string;            // 1 sentence tied to what was just said
    related: string[];            // canonical names
    confidence: number;           // identification confidence
    knowledge: 'known'|'unsure'|'unknown';
    needs_grounding: boolean;     // versioned products, recent releases, anything 'unsure'/'unknown'
  }>;
  relations: Array<{ terms: string[]; how: string; gotcha?: string }>;
};
```

- Render progressively: show the card header as soon as `canonical` + `one_liner` have streamed; fill bullets as they arrive.
- Thresholds (tunable in settings): `confidence < 0.5` -> drop; `0.5-0.75` -> show with a "?" badge; above -> normal.

### 5.6 Stage C — async grounding

- For cards with `needs_grounding`, fire a background call to a stronger Claude model with the **web search tool** (confirm tool name/params in docs). Ask for: verified one-liner, 3 bullets, key specs if it is hardware, release date/status, and 1-3 source URLs. Prefer vendor docs and official repos.
- When it returns, update the card in place (subtle "verified" tick + sources, "as of <date>"). If it contradicts Stage B, replace the text and show a small "corrected" marker.
- Persist the verified result into the glossary so next time it is a Stage A instant hit.
- Budget: max 3 concurrent grounding calls, per-session cap (setting), 20 s timeout. Grounding must never block or delay Stage B.

### 5.7 Card policy

- Dedup by canonical (case/spacing-insensitive) per session. A re-mention bumps the existing card to the top with a brief highlight instead of creating a new one.
- Rate limit: max 3 new cards per 20 s; overflow goes to a collapsed "more" row ranked by (unknown-to-owner likelihood, confidence, said-by-customer > said-by-me).
- "I know this" -> add to `known_terms`, never shown again, also sent to the LLM as the suppress list.
- Pin -> card stays in the pinned strip for the whole meeting.

## 6. The second-screen panel (UI spec)

### 6.1 Window

- Opens on the **non-primary display** (`screen.getAllDisplays()`), remembers bounds per display, falls back to primary.
- `setContentProtection(true)` by default so the panel is excluded from screen sharing/recording. Setting to turn off.
- Dark theme, high contrast, large type (term 28 px+, one-liner 20 px+). Designed to be read from 70 cm in peripheral vision. No animations beyond a 150 ms fade/slide for new cards.

### 6.2 Layout

```
+--------------------------------------------------------------+
| ● Listening   me ▮▮▯  them ▮▮▮▯      00:14:32     ⏸  ⚙      |
+--------------------------------------------------------------+
| Pinned:  [SiMa Modalix] [RF-DETR Nano]                       |
+--------------------------------------------------------------+
| HOW IT FITS                                                  |
| RF-DETR Nano on Modalix: <2 sentences> · Gotcha: <1 line>    |
+--------------------------------------------------------------+
| RF-DETR Nano                               model · ✓ verified|
| <one-liner>                                                  |
| • bullet  • bullet  • bullet                                 |
| Why here: <1 sentence>            [Know it] [Pin] [More ▾]   |
+--------------------------------------------------------------+
| SiMa.ai Modalix                            board · ? unsure  |
| ...                                                          |
+--------------------------------------------------------------+
| them: ...last two lines of live transcript...                |
+--------------------------------------------------------------+
| Ask about this meeting…                                  ⏎   |
+--------------------------------------------------------------+
```

- Newest card on top. Older cards compress to header + one-liner.
- "More" expands a deeper explanation generated on demand (separate LLM call with the transcript context), plus sources.
- **Bidi:** every text node gets `dir="auto"`; cards are laid out LTR or RTL according to `explainLanguage`; mixed Hebrew/English strings must render correctly (test with fixtures).

### 6.3 Global hotkeys (configurable)

- Pause/resume listening.
- "What was that?" — re-run extraction on the last 30 s with a lower threshold (for when he heard a term and no card appeared).
- Mark newest card as known.
- Focus the Ask box.

### 6.4 Ask box

Free-text question answered with the meeting transcript as context ("what did he mean by the compile step?"). Streams into a temporary card. Same fast model; escalate to grounding only if the answer needs facts the model flags as unsure.

### 6.5 Pre-meeting brief

A start screen where he can paste anything about the upcoming call: customer name, agenda, an email thread, a product list. On "Start":

1. Extract likely terms from the brief (one LLM call) -> add to this session's STT context.
2. Pre-generate and ground cards for them, so they are instant when spoken.
3. Keep the brief in the LLM context for the whole meeting (`why_here` gets much better).

Skippable: "Start without brief" is one click.

### 6.6 After the meeting

- Session saved locally: transcript (with me/them and timestamps), cards, relations.
- "Review" screen: terms learned this meeting, each with keep / edit / delete / mark-known; one click exports a Markdown summary (terms + explanations + sources + optional transcript).
- Glossary screen: search, edit, add aliases, import/export JSON.

## 7. Data

SQLite (`better-sqlite3`) in the app's userData dir.

- `glossary(id, canonical, kind, one_liner, bullets_json, long_md, sources_json, verified_at, aliases_json, created_at, updated_at)`
- `known_terms(canonical, added_at)`
- `sessions(id, title, brief, started_at, ended_at, stats_json)`
- `utterances(id, session_id, source, text, lang, start_ms, end_ms)`
- `cards(id, session_id, canonical, payload_json, first_seen_ms, pinned, grounded)`
- `relations(id, session_id, terms_json, how, gotcha, at_ms)`
- `settings(key, value)`

Secrets: API keys via Electron `safeStorage` (OS keychain-backed), never in SQLite, never in the renderer, never logged. `.env` supported in dev only.

**Seed glossary:** ship `seed/glossary.edge-ai.json` with ~80 canonical terms + aliases (including Hebrew-letter phonetic aliases), **without hand-written definitions**: run the grounding job once (`npm run seed:ground`) to generate verified explanations with sources. Starter term list to expand: SiMa.ai, Modalix, MLSoC, Palette SDK, RF-DETR (Nano/Small/Medium), YOLO family, DETR, transformer detector, NMS, mAP, quantization, INT8, QAT, PTQ, calibration set, ONNX, opset, TensorRT, TFLite, OpenVINO, NPU, TOPS, FPS/W, Hailo-8, Hailo-10, Jetson Orin, Qualcomm RB, Ambarella CV, Raspberry Pi AI HAT, GStreamer, pipeline element, MIPI CSI-2, GMSL, ISP, PoE, RTSP, H.264/H.265, BSP, Yocto, device tree, cross-compile, SoM, carrier board, eMMC, thermal throttling, model zoo, compile/partition (model compiler), operator support, fallback to CPU, pre/post-processing, letterbox, tracking (ByteTrack), ReID, segmentation, pose estimation, VLM, edge LLM, tokens/s, LoRA, distillation, pruning, OTA update, fleet management.

## 8. Privacy, safety, consent

- No audio written to disk. Transcript storage can be turned off per session ("ephemeral mode").
- Visible state at all times: listening / paused. Global pause hotkey.
- Onboarding screen states plainly: audio is streamed to the STT provider and transcript text to the LLM provider; the user is responsible for recording/transcription consent in his jurisdiction and for his employer's and customers' confidentiality rules. Include a per-session "confidential — do not ground on the web" toggle that disables Stage C (web queries can leak customer-internal names).
- Never send transcript text in web search queries beyond the canonical term itself.
- Content protection on by default (6.1).

## 9. Testing and evaluation (build this early, it is how you verify without a live meeting)

- **Replay mode:** `npm run replay -- fixtures/call01.wav` feeds a WAV through the real pipeline in real time (or `--speed 4`). `npm run replay:text -- fixtures/call01.jsonl` bypasses STT and feeds timed utterances straight into Stage A/B/C. The UI must work identically in replay.
- **Fixtures:** create `fixtures/*.jsonl` by hand: at least 40 utterances — Hebrew with English terms, English terms written in Hebrew letters, garbled terms, pure English, and plenty of utterances with **no** terms. Each has `expected_terms` and `forbidden_terms`. Include the canonical example from section 1 in three garbled spellings. Ask the owner to record 2-3 short real audio samples for the WAV fixtures in Phase 0.
- **Eval script:** `npm run eval` -> term precision, recall, canonicalization accuracy, false-card rate per minute on no-term speech, latency p50/p95 per stage, tokens and estimated cost per meeting hour. Write results to `eval/results/<date>.md`. **Targets:** precision >= 0.9, recall >= 0.75, false cards on no-term speech <= 1 per 5 min, latency per section 3.
- Tune prompt and thresholds against the eval, not by feel. Keep prompts in `src/main/llm/prompts/*.md`, versioned.
- **Unit tests:** resampler, PCM conversion, utterance assembler, fuzzy/alias matcher, dedup/rate-limit policy, schema validation, reconnect logic (mock socket).
- **Smoke (Playwright-Electron):** app launches, panel opens, replay of a fixture produces the expected cards, "Know it" suppresses on second replay.
- **Instrumentation:** every card records timestamps: speech_end, utterance_closed, llm_first_token, card_visible, grounded. A hidden debug overlay (hotkey) shows live latency and cost.

## 10. Phases

Each phase: build, test, update README, commit, stop and show the demo checklist.

### Phase 0 — De-risk spikes (throwaway code in `spikes/`)

- S1: Electron app that captures mic + system loopback on this machine and shows two live RMS meters. Play a YouTube video: "them" meter must move, and a saved 5 s debug WAV must be audible.
- S2: Node script streaming a WAV to Soniox; print tokens with language + finality. Try with and without a context list containing the section-1 terms; record the difference.
- S3: Node script: fixture utterance -> fast Claude model with the extraction schema, streaming; print time to first token and total.
- **Exit:** system audio verified non-silent; Hebrew/English mixed transcript is usable; end-to-end budget looks achievable. Write findings + chosen model IDs/params to `DECISIONS.md`. If S1 fails on this OS, stop and report options (virtual device fallback) before going on.

### Phase 1 — Skeleton + live transcript

- electron-vite scaffold, strict TS, lint, secure preload bridge, settings + key storage, second-display window.
- Audio worklets -> MessagePort -> main -> SttProvider (Soniox) x2 -> utterance assembler -> live transcript view with me/them labels.
- Replay mode (WAV) working.
- **Demo:** start, talk in mixed Hebrew/English while a video plays; both streams transcribe live, correctly labelled; kill the network for 5 s and it recovers.

### Phase 2 — Cards

- Stage B extractor with streaming structured output, zod validation, debounce/cancel.
- Card store, dedup, rate limit, confidence thresholds; card UI per 6.2 (without pin/ask yet).
- Text replay mode + first 20 fixtures + `npm run eval`.
- **Demo:** replay the section-1 fixture; correct cards appear within budget; no cards on small talk.

### Phase 3 — Glossary, memory, grounding

- SQLite, glossary + aliases, Stage A matcher, known-terms suppression, STT context built from glossary.
- Stage C grounding with web search, in-place card update, persistence back to glossary, "confidential" toggle.
- Seed glossary + `seed:ground` job.
- **Demo:** first replay shows a "?" card that becomes "verified" with sources; second replay shows the same card instantly from cache; "Know it" removes it for good.

### Phase 4 — The parts that make it great

- Relations / "How it fits" strip, pinned strip, "More" deep-dive, Ask box.
- Pre-meeting brief flow (6.5).
- Global hotkeys including "What was that?".
- Full bidi pass, typography and layout polish to the standard in 6.1. Expand fixtures to 40+, tune to hit the eval targets.
- **Demo:** paste a brief, start, replay; pre-warmed cards are instant; relation card appears when the two terms co-occur; all eval targets met.

### Phase 5 — Sessions, review, packaging

- Session persistence, review screen, Markdown export, glossary management screen.
- Onboarding (permissions per OS, headphones advice, consent/privacy text), silent-track guard, error states for missing keys / quota / offline.
- Deepgram fallback provider behind the interface.
- electron-builder config for the current OS; document signing/notarization steps for later rather than doing them.
- **Demo:** install the packaged app on this machine, run a real 10-minute call, review and export afterwards.

### Phase 6 — Hardening

- 90-minute soak replay: no memory growth, session rollover works, DB writes batched.
- Cost and latency report from real usage; cost shown per session in the review screen.
- Fix list from the owner's first real meetings.

## 11. Repo layout

```
gloss/
  PLAN.md  DECISIONS.md  README.md
  src/
    main/
      index.ts  windows.ts  ipc.ts  hotkeys.ts  settings.ts  secrets.ts
      audio/router.ts
      stt/{provider.ts,soniox.ts,deepgram.ts,mock.ts}
      pipeline/{assembler.ts,glossaryMatcher.ts,extractor.ts,grounder.ts,cardPolicy.ts,session.ts}
      llm/{client.ts,schema.ts,prompts/*.md}
      db/{index.ts,migrations/*.sql,repos/*.ts}
    preload/index.ts
    renderer/
      capture/{capture.ts,pcm-worklet.ts}
      panel/{App.tsx,components/*,store.ts}
      screens/{Start.tsx,Review.tsx,Glossary.tsx,Settings.tsx,Onboarding.tsx}
    shared/{types.ts,ipc-contract.ts}
  seed/glossary.edge-ai.json
  fixtures/{*.wav,*.jsonl}
  eval/{run.ts,results/}
  spikes/
  tests/{unit,smoke}
```

## 12. Explicitly out of scope (do not build)

- Bots that join meetings, calendar integration, cloud backend, accounts, billing, team sharing.
- Vector databases / RAG. The glossary is small; exact + fuzzy matching is enough.
- Local STT/LLM. Keep the interfaces clean so they can be added.
- Mobile.

Productization later (not now): backend key proxy, shared team glossaries, per-customer term packs, admin controls, signed auto-updating builds.

## 13. Definition of done

- A real mixed Hebrew/English call produces correct, non-repeating cards within the latency budget, on the second screen, invisible to screen share.
- Eval targets in section 9 are met and the report is committed.
- The canonical example from section 1 works from live speech, including the "how it fits" card.
- A fresh clone runs with `npm i && npm run dev` after adding two keys; README says exactly how.
