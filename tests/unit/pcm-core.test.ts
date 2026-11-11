import { describe, expect, it } from 'vitest';
import { downmix, encodeWav, floatToPcm16, Framer, Resampler, rms } from '../../spikes/s1-audio/pcm-core.js';

const sine = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

/** Feed in 128-sample render quanta, as an AudioWorklet does. */
function resampleInBlocks(input: Float32Array, inRate: number, block = 128): Float32Array {
  const r = new Resampler(inRate);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += block) parts.push(r.process(input.subarray(i, i + block)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Dominant frequency by counting upward zero crossings. */
const dominantHz = (x: Float32Array, rate: number) => {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings++;
  return (crossings * rate) / x.length;
};

describe('downmix', () => {
  it('averages channels', () => {
    expect(Array.from(downmix([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
  });
  it('passes mono through and tolerates no channels', () => {
    const mono = Float32Array.of(0.25);
    expect(downmix([mono])).toBe(mono);
    expect(downmix([]).length).toBe(0);
  });
});

describe('Resampler', () => {
  for (const inRate of [48000, 44100, 96000, 8000]) {
    it(`${inRate} Hz -> 16 kHz keeps duration and pitch across block boundaries`, () => {
      const out = resampleInBlocks(sine(440, inRate, 1), inRate);
      expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
      expect(Math.abs(dominantHz(out, 16000) - 440)).toBeLessThan(3);
    });
  }
  it('does not drift over a long stream', () => {
    const out = resampleInBlocks(new Float32Array(44100 * 60), 44100);
    expect(Math.abs(out.length - 16000 * 60)).toBeLessThanOrEqual(1);
  });
  it('preserves level for speech-band content', () => {
    const out = resampleInBlocks(sine(300, 48000, 1), 48000);
    const level = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
    expect(level).toBeGreaterThan(0.69);
    expect(level).toBeLessThan(0.72);
  });
  it('is the identity at 16 kHz', () => {
    const x = sine(440, 16000, 0.01);
    expect(new Resampler(16000).process(x)).toBe(x);
  });
});

describe('floatToPcm16', () => {
  it('maps full scale and clips out-of-range input', () => {
    expect(Array.from(floatToPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5)))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe('rms', () => {
  it('is exactly 0 for digital silence and ~0.707 for a full-scale sine', () => {
    expect(rms(new Int16Array(1600))).toBe(0);
    expect(rms(floatToPcm16(sine(440, 16000, 1)))).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms(new Int16Array(0))).toBe(0);
  });
});

describe('Framer', () => {
  it('emits fixed 100 ms frames and carries the remainder', () => {
    const f = new Framer();
    const input = Int16Array.from({ length: 4000 }, (_, i) => i);
    const frames = [...f.push(input.subarray(0, 1000)), ...f.push(input.subarray(1000, 3300)), ...f.push(input.subarray(3300))];
    expect(frames.map((x) => x.length)).toEqual([1600, 1600]);
    expect(frames[1]![0]).toBe(1600);
    expect(frames[1]![1599]).toBe(3199);
    // Frames are copies: a later push must not overwrite one already handed out.
    f.push(Int16Array.from({ length: 800 }, () => -1));
    expect(frames[0]![0]).toBe(0);
  });
});

describe('encodeWav', () => {
  it('writes a valid mono 16 kHz PCM16 header and little-endian samples', () => {
    const wav = encodeWav(Int16Array.of(1, -2, 258));
    const v = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([1, -2, 258]);
  });
});
