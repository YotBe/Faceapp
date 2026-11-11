// Phase 0 check page for the iPhone. Throwaway: proves the microphone,
// Soniox from the browser, and Claude extraction latency on the real device.
import Anthropic from '@anthropic-ai/sdk';
import { CONFIGS, runExtraction, score, type Extraction } from '../../shared/extraction.js';
import { CONTEXT_TERMS, FIXTURES } from '../../shared/fixtures.js';
import { encodeWav } from './pcm-core.js';
import workletUrl from './pcm-worklet.js?worker&url';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODEL = 'stt-rt-v6';
const SILENCE_GUARD_MS = 5000;
const QUIET_DBFS = -45; // sustained speech below this is too far from the speaker

// ---------- log ----------
const logLines: string[] = [];
function log(...parts: unknown[]) {
  const line = `${new Date().toISOString().slice(11, 23)} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  logLines.push(line);
  $('log').textContent = logLines.slice(-200).join('\n');
}
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
window.addEventListener('error', (e) => log('window error:', e.message));
window.addEventListener('unhandledrejection', (e) => log('unhandled:', errText(e.reason)));

$('copyLog').onclick = async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    $('copied').textContent = 'Copied — paste it to Claude.';
  } catch {
    $('copied').textContent = 'Could not copy; select the text below instead.';
  }
};

log('ua', navigator.userAgent);
log('secure context', window.isSecureContext, 'standalone', matchMedia('(display-mode: standalone)').matches);

// ---------- keys (this device only) ----------
const keyStore = {
  get: (name: string) => {
    try {
      return localStorage.getItem(`gloss.${name}`) ?? '';
    } catch {
      return '';
    }
  },
  set: (name: string, value: string) => {
    try {
      localStorage.setItem(`gloss.${name}`, value);
    } catch (e) {
      log('could not save key:', errText(e));
    }
  },
};
const sonioxInput = $<HTMLInputElement>('sonioxKey');
const anthropicInput = $<HTMLInputElement>('anthropicKey');
sonioxInput.value = keyStore.get('soniox');
anthropicInput.value = keyStore.get('anthropic');
const showKeysState = () => {
  $('keysState').textContent = `Soniox: ${sonioxInput.value ? 'set' : 'missing'} · Anthropic: ${anthropicInput.value ? 'set' : 'missing'}`;
};
showKeysState();
const saveKeys = () => {
  keyStore.set('soniox', sonioxInput.value.trim());
  keyStore.set('anthropic', anthropicInput.value.trim());
  showKeysState();
};
$('saveKeys').onclick = saveKeys;
sonioxInput.onchange = saveKeys;
anthropicInput.onchange = saveKeys;
const anthropic = () => {
  const apiKey = anthropicInput.value.trim();
  if (!apiKey) throw new Error('Enter the Anthropic API key first.');
  // The owner's own key on the owner's own phone; there is no server to hold it.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
};

// ---------- 1. microphone ----------
type Frame = { pcm: ArrayBuffer; rms: number };
let ctx: AudioContext | undefined;
let micTrack: MediaStreamTrack | undefined;
let frames = 0;
let startedAt = 0;
let lastNonSilent = 0;
let loudest = -Infinity;
let recording: Int16Array[] | undefined;
let onFrame: ((f: Frame) => void) | undefined;
let wakeLock: WakeLockSentinel | undefined;

async function holdWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    log('wake lock', wakeLock ? 'held' : 'unsupported');
  } catch (e) {
    log('wake lock failed:', errText(e));
  }
}
document.addEventListener('visibilitychange', () => {
  log('visibility', document.visibilityState, 'ctx', ctx?.state ?? 'none', 'track', micTrack?.readyState ?? 'none');
  if (document.visibilityState === 'visible' && ctx) {
    void holdWakeLock();
    void ctx.resume();
  }
});

$('micStart').onclick = async () => {
  $<HTMLButtonElement>('micStart').disabled = true;
  try {
    // Must be created inside the tap, or iOS leaves it suspended.
    ctx = new AudioContext();
    await ctx.resume();
    log('AudioContext', ctx.sampleRate, 'Hz', ctx.state);
    await ctx.audioWorklet.addModule(workletUrl);

    // Gloss plays no sound, so there is no echo to cancel; gain control helps
    // with a speaker that is across the desk.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    micTrack = stream.getAudioTracks()[0];
    if (!micTrack) throw new Error('no audio track');
    log('mic track', { label: micTrack.label, state: micTrack.readyState, settings: micTrack.getSettings() });
    micTrack.addEventListener('ended', () => log('mic track ended'));
    micTrack.addEventListener('mute', () => log('mic track muted (another app or a call took the microphone?)'));
    micTrack.addEventListener('unmute', () => log('mic track unmuted'));

    const node = new AudioWorkletNode(ctx, 'pcm-processor');
    node.port.onmessage = ({ data }: MessageEvent<Frame>) => {
      frames++;
      const db = data.rms > 0 ? 20 * Math.log10(data.rms) : -Infinity;
      if (data.rms > 0) lastNonSilent = performance.now();
      loudest = Math.max(loudest, db);
      recording?.push(new Int16Array(data.pcm.slice(0)));
      $('micBar').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      if (frames % 3 === 0) $('micVal').textContent = `${db === -Infinity ? '-inf' : db.toFixed(1)} dBFS · loudest ${loudest.toFixed(1)} · frame ${frames}`;
      onFrame?.(data);
    };
    // Routed to the output through a zero gain: some browsers only run a
    // worklet that leads to the destination. Nothing is audible.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);

    startedAt = performance.now();
    await holdWakeLock();
    setInterval(micGuard, 1000);
    $<HTMLButtonElement>('micRecord').disabled = false;
    $<HTMLButtonElement>('sttStart').disabled = false;
  } catch (e) {
    log('microphone failed:', errText(e));
    $('micWarn').textContent = `Microphone failed: ${errText(e)}\nAllow the microphone for this site (aA menu in the address bar > Website Settings), then reload.`;
    $<HTMLButtonElement>('micStart').disabled = false;
  }
};

function micGuard() {
  const now = performance.now();
  const silentFor = now - Math.max(lastNonSilent, startedAt);
  if (silentFor >= SILENCE_GUARD_MS) {
    $('micWarn').textContent =
      frames === 0
        ? 'The microphone is delivering no audio at all. Close other apps that use it (or end a call on this phone) and reload.'
        : `Exact silence for ${Math.round(silentFor / 1000)} s. The microphone is muted or blocked.`;
  } else if (now - startedAt > 8000 && loudest < QUIET_DBFS) {
    $('micWarn').textContent = `Very quiet (loudest so far ${loudest.toFixed(0)} dBFS). Move the phone closer to the speaker or turn the volume up.`;
  } else {
    $('micWarn').textContent = '';
  }
}

$('micRecord').onclick = async () => {
  const btn = $<HTMLButtonElement>('micRecord');
  btn.disabled = true;
  btn.textContent = 'Recording…';
  recording = [];
  await new Promise((r) => setTimeout(r, 5000));
  const chunks = recording;
  recording = undefined;
  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  let peak = 0;
  for (const c of chunks) {
    pcm.set(c, off);
    off += c.length;
  }
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  log(`recorded ${(pcm.length / 16000).toFixed(2)} s, peak ${peak}/32768${peak === 0 ? ' (SILENT)' : ''}`);
  const audio = $<HTMLAudioElement>('playback');
  audio.src = URL.createObjectURL(new Blob([encodeWav(pcm) as BlobPart], { type: 'audio/wav' }));
  audio.hidden = false;
  btn.textContent = 'Record 5 s';
  btn.disabled = false;
};

// ---------- 2. live transcript ----------
type SonioxToken = { text: string; is_final: boolean; language?: string; speaker?: string };
type SonioxMsg = { tokens?: SonioxToken[]; finished?: boolean; error_code?: number; error_type?: string; error_message?: string };

let ws: WebSocket | undefined;
let finalText = '';
let utterance = '';
let utteranceAudioEndedAt = 0;
const shown: string[] = [];
let extracting = false;
let pendingUtterance = '';

function renderTranscript(interim: string) {
  const el = $('transcript');
  el.textContent = finalText;
  const span = document.createElement('span');
  span.className = 'interim';
  span.textContent = interim;
  el.append(span);
}

$('sttStart').onclick = () => {
  const key = sonioxInput.value.trim();
  if (!key) {
    $('sttState').textContent = 'Enter the Soniox API key first.';
    return;
  }
  const useContext = $<HTMLInputElement>('useContext').checked;
  finalText = '';
  utterance = '';
  renderTranscript('');
  $('cards').replaceChildren();
  shown.length = 0;
  $<HTMLButtonElement>('sttStart').disabled = true;
  $('sttState').textContent = 'Connecting…';
  const t0 = performance.now();

  // Browsers cannot set headers on a WebSocket; Soniox takes the key in the
  // protocols list. A bad key still opens, then an error frame arrives.
  const sock = new WebSocket(SONIOX_URL, ['soniox-api-key', key]);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  let firstToken = true;

  sock.onopen = () => {
    log(`soniox open in ${Math.round(performance.now() - t0)} ms, context ${useContext ? 'on' : 'off'}`);
    sock.send(
      JSON.stringify({
        model: SONIOX_MODEL,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ['he', 'en'],
        enable_language_identification: true,
        enable_endpoint_detection: true,
        enable_speaker_diarization: true,
        ...(useContext
          ? { context: { general: [{ key: 'domain', value: 'Edge AI hardware and computer-vision model deployment' }], terms: CONTEXT_TERMS } }
          : {}),
      }),
    );
    onFrame = (f) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(f.pcm);
      if (f.rms > 0.01) utteranceAudioEndedAt = performance.now();
    };
    $('sttState').textContent = 'Listening — speak now.';
    $<HTMLButtonElement>('sttStop').disabled = false;
  };

  sock.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as SonioxMsg;
    if (msg.error_code) {
      log('soniox error', msg);
      $('sttState').innerHTML = '';
      $('sttState').append(Object.assign(document.createElement('span'), { className: 'bad', textContent: `Soniox error ${msg.error_code} ${msg.error_type ?? ''}: ${msg.error_message ?? ''}` }));
      return;
    }
    let interim = '';
    for (const t of msg.tokens ?? []) {
      if (firstToken) {
        firstToken = false;
        log(`first token ${Math.round(performance.now() - t0)} ms after connect`);
      }
      if (t.text === '<end>') {
        const text = utterance.trim();
        utterance = '';
        finalText += ' ⏎\n';
        log('endpoint', { delayMs: Math.round(performance.now() - utteranceAudioEndedAt), text });
        if (text && $<HTMLInputElement>('liveCards').checked) void liveExtract(text, utteranceAudioEndedAt);
      } else if (t.is_final) {
        finalText += t.text;
        utterance += t.text;
      } else {
        interim += t.text;
      }
    }
    renderTranscript(interim);
    if (msg.finished) log('soniox finished');
  };
  sock.onerror = () => log('soniox socket error');
  sock.onclose = (ev) => {
    log('soniox closed', ev.code, ev.reason);
    onFrame = undefined;
    if (!$('sttState').querySelector('.bad')) {
      $('sttState').textContent = ev.code === 1006 ? 'Could not reach Soniox, or the connection dropped (1006). Check the internet connection and try again.' : `Stopped (${ev.code}).`;
    }
    $<HTMLButtonElement>('sttStart').disabled = false;
    $<HTMLButtonElement>('sttStop').disabled = true;
  };
};

$('sttStop').onclick = () => {
  onFrame = undefined;
  if (ws?.readyState === WebSocket.OPEN) ws.send(''); // empty text frame ends the stream
};

/** One call in flight; anything said meanwhile is merged into one follow-up. */
async function liveExtract(text: string, speechEndedAt: number) {
  if (extracting) {
    pendingUtterance = `${pendingUtterance} ${text}`.trim();
    return;
  }
  extracting = true;
  try {
    const r = await runExtraction(anthropic(), { utterance: text, alreadyShown: shown });
    const sinceSpeech = Math.round(performance.now() - speechEndedAt - (r.totalMs - (r.headerMs ?? r.totalMs)));
    log('live cards', { terms: r.parsed.terms.map((t) => t.canonical), ttftMs: Math.round(r.ttftMs ?? -1), headerMs: Math.round(r.headerMs ?? -1), totalMs: Math.round(r.totalMs), speechEndToHeaderMs: r.headerMs === undefined ? null : sinceSpeech });
    renderCards($('cards'), r.parsed, r.headerMs === undefined ? '' : `${(sinceSpeech / 1000).toFixed(1)} s after you stopped speaking`);
    for (const t of r.parsed.terms) shown.push(t.canonical);
  } catch (e) {
    log('live extraction failed:', errText(e));
  } finally {
    extracting = false;
    if (pendingUtterance) {
      const next = pendingUtterance;
      pendingUtterance = '';
      void liveExtract(next, performance.now());
    }
  }
}

function renderCards(into: HTMLElement, x: Extraction, note: string) {
  const el = (tag: string, cls: string, text: string) => Object.assign(document.createElement(tag), { className: cls, textContent: text, dir: 'auto' });
  for (const rel of x.relations) {
    const card = el('div', 'card rel', '');
    card.append(el('div', 'meta', `HOW IT FITS · ${rel.terms.join(' + ')}`), el('div', 'one', rel.how));
    if (rel.gotcha) card.append(el('div', 'meta', `Gotcha: ${rel.gotcha}`));
    into.prepend(card);
  }
  for (const t of x.terms) {
    const card = el('div', 'card', '');
    const badge = t.confidence < 0.75 || t.knowledge !== 'known' ? ' · ? unsure' : '';
    card.append(el('div', 'term', t.canonical), el('div', 'meta', `${t.kind}${badge} · heard “${t.heard_as}”${note ? ` · ${note}` : ''}`), el('div', 'one', t.one_liner));
    const ul = document.createElement('ul');
    for (const b of t.bullets) ul.append(el('li', '', b));
    card.append(ul);
    if (t.why_here) card.append(el('div', 'meta', `Why here: ${t.why_here}`));
    into.prepend(card);
  }
}

// ---------- 3. card speed ----------
$('extractRun').onclick = async () => {
  const btn = $<HTMLButtonElement>('extractRun');
  const out = $('extractOut');
  out.replaceChildren();
  let client: Anthropic;
  try {
    client = anthropic();
  } catch (e) {
    out.textContent = errText(e);
    return;
  }
  btn.disabled = true;
  const ms = (n: number | undefined) => (n === undefined ? '—' : String(Math.round(n)));
  for (const cfg of CONFIGS) {
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>sentence</th><th>first token</th><th>card header</th><th>done</th><th></th></tr>';
    out.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: cfg.name }), table);
    const headers: number[] = [];
    for (const fx of FIXTURES) {
      const row = table.insertRow();
      row.insertCell().textContent = fx.id;
      try {
        const r = await runExtraction(client, { utterance: fx.text }, cfg);
        const s = score(fx, r.parsed);
        if (r.headerMs !== undefined) headers.push(r.headerMs);
        for (const v of [ms(r.ttftMs), ms(r.headerMs), ms(r.totalMs), s.ok ? 'ok' : 'MISS']) row.insertCell().textContent = v;
        log('extract', { cfg: cfg.name, id: fx.id, ok: s.ok, got: s.got, missed: s.missed, unexpected: s.unexpected, ttftMs: ms(r.ttftMs), headerMs: ms(r.headerMs), totalMs: ms(r.totalMs), in: r.usage.input_tokens, cacheRead: r.usage.cache_read_input_tokens, out: r.usage.output_tokens });
      } catch (e) {
        const cell = row.insertCell();
        cell.colSpan = 4;
        cell.className = 'bad';
        cell.textContent = errText(e);
        log('extract failed', fx.id, errText(e));
        // A bad key or no connection fails every sentence the same way: stop.
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.APIConnectionError) {
          btn.disabled = false;
          return;
        }
      }
    }
    headers.sort((a, b) => a - b);
    if (headers.length) {
      out.append(Object.assign(document.createElement('p'), { textContent: `Card header: median ${Math.round(headers[Math.floor(headers.length / 2)]!)} ms, slowest ${Math.round(headers.at(-1)!)} ms. Budget is 2000 ms including the pause Soniox waits for.` }));
    }
  }
  btn.disabled = false;
};
