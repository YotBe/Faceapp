// Spike S2: stream a WAV to Soniox real-time STT, print tokens with language
// and finality; run once without and once with a context term list.
//
//   npm run spike:s2 -- path/to/sample.wav
//
// The WAV must be mono 16 kHz PCM16. Convert anything else with:
//   ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le out.wav
//
// Protocol per docs.soniox.com (read 2026-11-11); see DECISIONS.md.
import fs from 'node:fs';
import WebSocket from 'ws';
import { CONTEXT_TERMS } from '../src/llm/fixtures.js';

const URL = process.env.SONIOX_WS_URL ?? 'wss://stt-rt.soniox.com/transcribe-websocket';
const MODEL = process.env.SONIOX_MODEL ?? 'stt-rt-v6';
const FRAME_MS = 100;
const RATE = 16000;

type Token = { text: string; is_final: boolean; language?: string; speaker?: string; start_ms?: number; end_ms?: number };
type Msg = { tokens?: Token[]; finished?: boolean; error_code?: number; error_type?: string; error_message?: string };

function readWavPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
        throw new Error(`need mono 16 kHz PCM16, got ${JSON.stringify(fmt)} — convert with ffmpeg (see header)`);
      }
      return buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

async function run(pcm: Buffer, label: string, context: unknown): Promise<string> {
  const apiKey = process.env.SONIOX_API_KEY;
  if (!apiKey) throw new Error('SONIOX_API_KEY is not set (put it in .env)');
  console.log(`\n=== ${label} (model ${MODEL}) ===`);
  const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  const finalText: string[] = [];
  const t0 = Date.now();
  let firstTokenMs: number | undefined;

  const done = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code, reason) => {
      if (code !== 1000 && code !== 1005) console.log(`socket closed: ${code} ${reason.toString()}`);
      resolve();
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      if (msg.error_code) return reject(new Error(`Soniox error ${msg.error_code} ${msg.error_type}: ${msg.error_message}`));
      for (const t of msg.tokens ?? []) {
        firstTokenMs ??= Date.now() - t0;
        if (t.text === '<end>') {
          console.log(`  [endpoint @ ${Date.now() - t0} ms wall]`);
          continue;
        }
        if (t.is_final) {
          finalText.push(t.text);
          console.log(`  FINAL  ${(t.language ?? '--').padEnd(3)} ${String(t.start_ms ?? '').padStart(6)}-${String(t.end_ms ?? '').padEnd(6)} ${JSON.stringify(t.text)}`);
        }
      }
      const interim = (msg.tokens ?? []).filter((t) => !t.is_final).map((t) => t.text).join('');
      if (interim) console.log(`  interim    ${JSON.stringify(interim)}`);
      if (msg.finished) ws.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      model: MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: RATE,
      num_channels: 1,
      language_hints: ['he', 'en'],
      enable_language_identification: true,
      enable_endpoint_detection: true,
      enable_speaker_diarization: true,
      ...(context ? { context } : {}),
    }),
  );

  // Real-time pacing: this is what the live app will do, and it makes the
  // endpoint timings meaningful.
  const frameBytes = (RATE * 2 * FRAME_MS) / 1000;
  for (let off = 0; off < pcm.length && ws.readyState === WebSocket.OPEN; off += frameBytes) {
    ws.send(pcm.subarray(off, off + frameBytes));
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(''); // empty TEXT frame ends the stream (an empty binary frame does not)
  await done;

  const text = finalText.join('');
  console.log(`first token after ${firstTokenMs ?? 'n/a'} ms; transcript:\n  ${text}`);
  return text;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run spike:s2 -- <mono-16k-pcm16.wav>');
  process.exit(1);
}
const pcm = readWavPcm(file);
console.log(`${file}: ${(pcm.length / 2 / RATE).toFixed(1)} s of audio`);

let plain: string;
let biased: string;
try {
  plain = await run(pcm, 'WITHOUT context', undefined);
  biased = await run(pcm, 'WITH context terms', { terms: CONTEXT_TERMS });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

console.log('\n=== difference ===');
console.log('without:', plain);
console.log('with:   ', biased);
for (const term of CONTEXT_TERMS) {
  const a = plain.toLowerCase().includes(term.toLowerCase());
  const b = biased.toLowerCase().includes(term.toLowerCase());
  if (a !== b) console.log(`  ${term}: ${a ? 'present' : 'absent'} -> ${b ? 'present' : 'absent'}`);
}
