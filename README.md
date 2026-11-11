# Gloss

Live jargon explainer for meetings. Listens to a call on your machine (mic +
system audio), transcribes it, and shows cards on your second screen explaining
the technical terms as they come up. Nothing joins the meeting.

- `PLAN.md` — the build plan. Read it first.
- `DECISIONS.md` — what was chosen and why, and what is still unverified.

**Current state: Phase 0 (de-risk spikes).** There is no app yet — three
throwaway spikes in `spikes/`.

## Setup

Node 22+.

```bash
npm install
cp .env.example .env    # then fill in SONIOX_API_KEY and ANTHROPIC_API_KEY
```

## Phase 0 spikes

### S1 — audio capture (the risky one)

```bash
npm run spike:s1
```

1. Play a YouTube video (speakers or headphones).
2. Click **Start capture**. Allow the microphone if asked.
3. The **me** meter should move when you talk, the **them** meter when the video plays.
4. Click **Record 5 s to WAV**, then play `spikes/out/them.wav` and `spikes/out/me.wav`.

If **them** stays flat:

- **macOS** (14.2 or later required): System Settings → Privacy & Security →
  Screen & System Audio Recording → *System Audio Recording Only* → allow your
  **terminal or IDE** (it owns the permission while the app is unpackaged),
  then quit and reopen the terminal.
- **Linux**: pick the "Monitor of …" device in the source dropdown before starting.
- **Anywhere**: install a virtual device (BlackHole, VB-Cable) and pick it in the dropdown.

### S2 — Soniox transcription

Record 10–30 s of yourself saying something like the PLAN §1 example in mixed
Hebrew/English, then:

```bash
ffmpeg -i recording.m4a -ac 1 -ar 16000 -c:a pcm_s16le sample.wav
npm run spike:s2 -- sample.wav
```

It transcribes twice — without and with a jargon context list — and prints the
difference. The Soniox endpoint, model id and field names in this script are
**unverified** (see `DECISIONS.md`); override with `SONIOX_MODEL` / `SONIOX_WS_URL`.

### S3 — term extraction latency

```bash
npm run spike:s3                  # all fixtures
npm run spike:s3 -- canon-clean   # one
```

Prints, per fixture, time to first token, time until a card header could
render, total time, and the extracted terms.

## Checks

```bash
npm run typecheck
npm test
```
