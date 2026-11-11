// Runs one listening session: microphone -> Soniox -> utterances -> Claude ->
// cards in the store. Also runs the scripted demo through the same store.
import Anthropic from '@anthropic-ai/sdk';
import { holdWakeLock, releaseWakeLock, startCapture, type Capture, type Frame } from '../audio/capture.js';
import { getKey } from '../keys.js';
import { runExtraction, type Extraction } from '../llm/extraction.js';
import { CONTEXT_TERMS } from '../llm/fixtures.js';
import { openSoniox, type SonioxStream } from '../stt/soniox.js';
import { useGloss } from '../store.js';
import { DEMO } from './demo.js';
import { mergeExtraction } from './policy.js';

const S = useGloss;
const MAX_RETRIES = 4;
const LONG_UTTERANCE_CHARS = 260; // close a monologue that never pauses
const SILENCE_GUARD_MS = 5000;

let capture: Capture | undefined;
let stream: SonioxStream | undefined;
let ticker: number | undefined;
let retries = 0;
let utterance = '';
let lineOpen = false;
let lineId = 0;
let lastLoudAt = 0;
let lastNonSilentAt = 0;
let hiddenAt = 0;
let inFlight = false;
let pending: { text: string; spokeAt: number } | undefined;
let demoRun = 0;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function startTicker() {
  window.clearInterval(ticker);
  let last = Date.now();
  ticker = window.setInterval(() => {
    const now = Date.now();
    if (S.getState().phase === 'listening') S.setState((s) => ({ elapsedMs: s.elapsedMs + (now - last) }));
    last = now;
  }, 500);
}

// ---------- transcript ----------
function appendFinal(text: string, speaker: string | undefined) {
  if (!text) return;
  utterance += text;
  S.setState((s) => {
    const lines = s.lines.slice(-30);
    if (lineOpen && lines.length) {
      const last = lines[lines.length - 1]!;
      lines[lines.length - 1] = { ...last, text: last.text + text, speaker: speaker ?? last.speaker };
    } else {
      lines.push({ id: ++lineId, text: text.trimStart(), speaker });
      lineOpen = true;
    }
    return { lines };
  });
}

function closeUtterance() {
  const text = utterance.trim();
  utterance = '';
  lineOpen = false;
  if (text) queueExtraction(text, lastLoudAt || performance.now());
}

// ---------- cards ----------
function applyExtraction(x: Extraction, latencyS?: number) {
  const s = S.getState();
  const m = mergeExtraction(x, s.cards, new Set(s.known), Date.now(), latencyS);
  if (m.cards.length || m.bumped.length || m.relations.length) s.addCards(m.cards, m.relations, m.highlights, m.bumped);
}

/** One call in flight; whatever is said meanwhile becomes one follow-up. */
function queueExtraction(text: string, spokeAt: number) {
  if (inFlight) {
    pending = { text: pending ? `${pending.text} ${text}` : text, spokeAt };
    return;
  }
  inFlight = true;
  S.setState({ thinking: true });
  const s = S.getState();
  const context = s.lines.slice(-12, -1).map((l) => `${l.speaker ? `S${l.speaker}` : '-'}: ${l.text}`).join('\n');
  const client = new Anthropic({ apiKey: getKey('anthropic'), dangerouslyAllowBrowser: true });
  runExtraction(client, { utterance: text, transcriptSoFar: context, alreadyShown: [...s.cards.map((c) => c.canonical), ...s.known] })
    .then((r) => {
      if (S.getState().phase === 'idle') return;
      applyExtraction(r.parsed, (performance.now() - spokeAt) / 1000);
    })
    .catch((e: unknown) => {
      const message =
        e instanceof Anthropic.AuthenticationError ? 'Anthropic did not accept the API key. Check it in settings.'
        : e instanceof Anthropic.RateLimitError ? 'Anthropic is rate-limiting this key; some cards will be missed.'
        : e instanceof Anthropic.APIConnectionError ? 'Could not reach Anthropic. Check the internet connection.'
        : `Could not make cards: ${errText(e)}`;
      S.setState({ error: message });
    })
    .finally(() => {
      inFlight = false;
      S.setState({ thinking: false });
      const next = pending;
      pending = undefined;
      if (next && S.getState().phase === 'listening') queueExtraction(next.text, next.spokeAt);
    });
}

// ---------- live ----------
function onFrame(f: Frame) {
  const now = performance.now();
  if (f.rms > 0) lastNonSilentAt = now;
  if (f.rms > 0.01) lastLoudAt = now;
  // -60 dBFS..0 dBFS mapped to 0..1 for the waveform.
  const level = f.rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(f.rms) + 60) / 60)) : 0;
  const silent = now - lastNonSilentAt > SILENCE_GUARD_MS;
  S.setState((s) => ({
    level,
    notice: silent ? 'The microphone is delivering silence. Close other apps that use it, then pause and resume.' : s.notice?.startsWith('The microphone is delivering') ? null : s.notice,
  }));
  stream?.send(f.pcm);
}

function connect() {
  stream = openSoniox(getKey('soniox'), CONTEXT_TERMS, {
    onText(finalDelta, interim, speaker) {
      retries = 0;
      if (S.getState().notice === 'Reconnecting…') S.setState({ notice: null });
      appendFinal(finalDelta, speaker);
      S.setState({ interim });
      if (utterance.length > LONG_UTTERANCE_CHARS) closeUtterance();
    },
    onEndpoint: closeUtterance,
    onClosed(reason) {
      stream = undefined;
      if (S.getState().phase !== 'listening' || S.getState().demo) return;
      if (reason?.retryable !== false && retries < MAX_RETRIES) {
        S.setState({ notice: 'Reconnecting…' });
        window.setTimeout(() => S.getState().phase === 'listening' && !stream && connect(), 500 * 2 ** retries++);
        return;
      }
      stopAudio();
      const gaveUp = reason?.retryable !== false;
      S.setState({
        phase: 'paused',
        notice: null,
        error: gaveUp ? 'Could not reach Soniox. Check the internet connection, then tap Resume.' : (reason?.message ?? 'The connection to Soniox closed.'),
      });
    },
  });
}

function stopAudio() {
  closeUtterance();
  stream?.finish();
  stream = undefined;
  capture?.stop();
  capture = undefined;
  releaseWakeLock();
  S.setState({ level: 0, interim: '' });
}

async function openMicAndStream(): Promise<boolean> {
  try {
    lastNonSilentAt = performance.now();
    capture = await startCapture(onFrame, (why) => S.setState({ notice: `${why} Pause and resume to continue.` }));
  } catch (e) {
    const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    S.setState({
      phase: S.getState().lines.length ? 'paused' : 'idle',
      error: denied ? 'Gloss needs the microphone. Allow it for this site in Safari’s website settings, then try again.' : `Could not start the microphone: ${errText(e)}`,
    });
    return false;
  }
  retries = 0;
  connect();
  await holdWakeLock();
  return true;
}

/** Call from a tap. Returns false when keys are missing. */
export async function startLive(): Promise<boolean> {
  if (!getKey('soniox') || !getKey('anthropic')) return false;
  demoRun++;
  utterance = '';
  lineOpen = false;
  pending = undefined;
  S.getState().reset(false);
  startTicker();
  await openMicAndStream();
  return true;
}

export function pause() {
  const s = S.getState();
  if (s.phase !== 'listening') return;
  S.setState({ phase: 'paused', notice: null });
  if (!s.demo) stopAudio();
}

/** Call from a tap. */
export async function resume() {
  const s = S.getState();
  if (s.phase !== 'paused') return;
  S.setState({ phase: 'listening', error: null, notice: null });
  if (!s.demo) await openMicAndStream();
}

export function end() {
  const s = S.getState();
  if (!s.demo && s.phase === 'listening') stopAudio();
  demoRun++;
  window.clearInterval(ticker);
  S.setState({ phase: 'ended', level: 0, interim: '', notice: null });
}

export function home() {
  demoRun++;
  window.clearInterval(ticker);
  S.setState({ phase: 'idle', error: null, notice: null });
}

document.addEventListener('visibilitychange', () => {
  const s = S.getState();
  if (s.demo || s.phase !== 'listening') return;
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  void holdWakeLock();
  void capture?.resume();
  if (hiddenAt && Date.now() - hiddenAt > 2000) {
    S.setState({ notice: 'Gloss stopped listening while it was in the background. Anything said then was missed.' });
    window.setTimeout(() => S.getState().notice?.startsWith('Gloss stopped listening') && S.setState({ notice: null }), 6000);
  }
});

// ---------- demo ----------
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function startDemo() {
  const run = ++demoRun;
  lineOpen = false;
  S.getState().reset(true);
  startTicker();
  const alive = () => run === demoRun && S.getState().phase !== 'idle' && S.getState().phase !== 'ended';
  const whilePaused = async () => {
    while (alive() && S.getState().phase === 'paused') await sleep(150);
  };

  for (const step of DEMO) {
    if (!alive()) return;
    if ('wait' in step) {
      S.setState({ level: 0.08 });
      await sleep(step.wait);
      await whilePaused();
      continue;
    }
    // Words arrive a few at a time, as they do from the recogniser.
    const words = step.say.split(' ');
    for (let i = 1; i <= words.length; i++) {
      if (!alive()) return;
      await whilePaused();
      S.setState({ interim: words.slice(0, i).join(' '), level: 0.35 + Math.random() * 0.55 });
      await sleep(170 + Math.random() * 120);
    }
    if (!alive()) return;
    S.setState((s) => ({ interim: '', level: 0.1, lines: [...s.lines, { id: ++lineId, text: step.say, speaker: step.speaker }] }));
    if (step.cards) {
      S.setState({ thinking: true });
      await sleep(900);
      if (!alive()) return;
      S.setState({ thinking: false });
      applyExtraction(step.cards); // no latency figure: nothing was measured
    }
  }
  if (alive()) S.setState({ level: 0, notice: 'End of the demo. Tap “End” to see the cheat sheet.' });
}
