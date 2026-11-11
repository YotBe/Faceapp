# Gloss

Live jargon explainer for meetings, on your iPhone. The phone sits on the desk,
listens through its microphone, and shows cards explaining the technical terms
as they come up. Nothing joins the meeting.

- `PLAN.md` — the build plan. Read it first.
- `DECISIONS.md` — what was chosen and why, and what is still unverified.

**Current state:** the main screen exists and has a built-in demo. Live
listening is written but has not yet run on a real iPhone or against either
service — that is what the phone check is for.

- `/` — the app. *Watch a demo* needs no keys. *Start listening* needs both.
- `/check.html` — the phone check: tests the microphone and both services and
  produces a log to paste back.

## What it needs to work

- The call has to play on **speakers** (laptop, speakerphone, or people in the
  room). With headphones on, the phone hears only you.
- The page has to stay open and in front. Switching apps pauses it.

## Phase 0: run the check on the iPhone

1. Open `/check.html` on the deployed site in **Safari** on the iPhone.
2. Paste your Soniox and Anthropic API keys. They are saved on the phone only.
3. **Microphone** — play a video on your laptop speakers, tap *Start
   microphone*, allow access. The bar should move. Tap *Record 5 s* and play it
   back: can you make out the words?
4. **Live transcript** — tap *Start transcribing* and say something in mixed
   Hebrew and English with technical terms. Cards should appear under the
   transcript. Do it once with "Give Soniox the jargon list" off and once on.
5. **Card speed** — tap *Run*.
6. Tap *Copy log* and paste it back.

## Development

Node 22+.

```bash
npm install
npm run dev        # the app, and the check page at /check.html
npm run build      # static files in dist/
npm run typecheck
npm test
```

Microphone access needs HTTPS, so on a real phone use the deployed page; `npm
run dev` over plain HTTP only works on `localhost`.

Node versions of two checks, for use with a `.env` file (`cp .env.example .env`):

```bash
npm run spike:s3                 # extraction latency
npm run spike:s2 -- sample.wav   # Soniox on a mono 16 kHz PCM16 WAV
```
