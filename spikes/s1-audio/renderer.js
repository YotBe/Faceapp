import { encodeWav } from './pcm-core.js';

const $ = (id) => document.getElementById(id);
const log = (...a) => {
  $('log').textContent += a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  $('log').scrollTop = $('log').scrollHeight;
};

const SILENCE_GUARD_MS = 5000;
const state = {
  me: { frames: 0, lastNonSilent: 0, recording: null },
  them: { frames: 0, lastNonSilent: 0, recording: null },
};
let ctx;
let startedAt = 0;

const env = await window.spike.env();
log('env', env);

// Linux has no loopback: list input devices so a PulseAudio/PipeWire monitor
// source (or any virtual device, on any OS) can stand in for system audio.
async function listInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const sel = $('themSource');
  for (const d of devices.filter((d) => d.kind === 'audioinput')) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = `input: ${d.label || d.deviceId}`;
    sel.append(o);
  }
  if (env.platform === 'linux' && sel.options.length > 1) sel.selectedIndex = 1;
}

async function attach(name, stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error(`${name}: stream has no audio track`);
  log(name, 'track', { label: track.label, readyState: track.readyState, settings: track.getSettings() });
  // macOS without the System Audio Recording permission: the track exists but
  // is already 'ended' and never delivers samples. No error is thrown.
  if (track.readyState === 'ended') log(name, 'WARNING: track is already ended — permission missing?');
  track.addEventListener('ended', () => log(name, 'track ended'));

  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = ({ data }) => {
    const s = state[name];
    s.frames++;
    if (data.rms > 0) s.lastNonSilent = performance.now();
    if (s.recording) s.recording.push(new Int16Array(data.pcm));
    const db = data.rms > 0 ? 20 * Math.log10(data.rms) : -Infinity;
    $(`${name}Bar`).style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    $(`${name}Val`).textContent = `${db === -Infinity ? '-inf' : db.toFixed(1)} dBFS  #${s.frames}`;
  };
  ctx.createMediaStreamSource(stream).connect(node);
  // Not connected to ctx.destination: we must not play the call back out.
}

async function getThemStream() {
  const choice = $('themSource').value;
  if (choice !== 'loopback') {
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: choice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  return stream;
}

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    ctx = new AudioContext();
    log('AudioContext sampleRate', ctx.sampleRate);
    await ctx.audioWorklet.addModule('./pcm-worklet.js');

    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    await attach('me', mic);

    try {
      await attach('them', await getThemStream());
    } catch (e) {
      log('them: capture failed:', String(e));
      $('warn').textContent = `System audio capture failed: ${e}\nPick an input device above (monitor source / BlackHole / VB-Cable) and restart.`;
    }
    startedAt = performance.now();
    $('record').disabled = false;
    setInterval(silenceGuard, 1000);
  } catch (e) {
    log('start failed:', String(e));
    $('start').disabled = false;
  }
};

function silenceGuard() {
  const now = performance.now();
  const s = state.them;
  const since = now - Math.max(s.lastNonSilent, startedAt);
  if (since < SILENCE_GUARD_MS) {
    $('warn').textContent = '';
    return;
  }
  const fix = {
    darwin: 'macOS: System Settings > Privacy & Security > Screen & System Audio Recording > "System Audio Recording Only": allow the app that launched this (your terminal or IDE when unpackaged), then restart it.',
    win32: 'Windows: check that sound is playing on the default output device, and that the app is not muted in the volume mixer.',
    linux: 'Linux: choose the "Monitor of …" input device above, or route audio through a virtual device.',
  }[env.platform];
  $('warn').textContent = s.frames === 0
    ? `No system audio frames at all (track delivers nothing).\n${fix}`
    : `No system audio detected for ${Math.round(since / 1000)} s (exact digital silence). Play something.\n${fix}`;
}

$('record').onclick = async () => {
  $('record').disabled = true;
  state.me.recording = [];
  state.them.recording = [];
  log('recording 5 s…');
  await new Promise((r) => setTimeout(r, 5000));
  for (const name of ['me', 'them']) {
    const chunks = state[name].recording;
    state[name].recording = null;
    const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    const file = await window.spike.saveWav(name, encodeWav(pcm));
    log(`${name}: ${(pcm.length / 16000).toFixed(2)} s, peak ${peak}/32768 ${peak === 0 ? '(SILENT)' : ''} -> ${file}`);
  }
  $('record').disabled = false;
};

await listInputs();
