// Pure DSP shared by the AudioWorklet and the unit tests. No DOM, no Node APIs.
// @ts-check

export const TARGET_RATE = 16000;

/** Average all channels into one. @param {Float32Array[]} channels @returns {Float32Array} */
export function downmix(channels) {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Streaming resampler: box-filter average when downsampling (cheap anti-alias,
 * good enough for speech), linear interpolation otherwise. Keeps its phase
 * across calls so block boundaries produce no clicks or drift.
 */
export class Resampler {
  /** @param {number} inRate @param {number} [outRate] */
  constructor(inRate, outRate = TARGET_RATE) {
    this.step = inRate / outRate;
    this.pos = 0; // read position, in input samples, relative to the next block
    this.last = 0; // last sample of the previous block, for interpolation
    this.acc = 0; // box-filter accumulator
    this.accN = 0;
    this.next = this.step; // input index at which the current box closes
    this.seen = 0;
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  process(input) {
    if (this.step === 1) return input;
    const out = [];
    if (this.step > 1) {
      for (let i = 0; i < input.length; i++) {
        this.acc += input[i] ?? 0;
        this.accN++;
        this.seen++;
        if (this.seen >= this.next) {
          out.push(this.acc / this.accN);
          this.acc = 0;
          this.accN = 0;
          this.next += this.step;
        }
      }
      // Keep the counters small on a stream that runs for hours.
      if (this.seen > 1e9) {
        this.next -= this.seen;
        this.seen = 0;
      }
    } else {
      while (this.pos < input.length) {
        const i = Math.floor(this.pos);
        const a = i === 0 ? this.last : (input[i - 1] ?? 0);
        const b = input[i] ?? 0;
        out.push(a + (b - a) * (this.pos - i));
        this.pos += this.step;
      }
      this.pos -= input.length;
      this.last = input[input.length - 1] ?? this.last;
    }
    return Float32Array.from(out);
  }
}

/** Float [-1,1] -> PCM16 LE, clipped. @param {Float32Array} f @returns {Int16Array} */
export function floatToPcm16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** RMS of PCM16 samples, normalised to 0..1. @param {Int16Array} pcm */
export function rms(pcm) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = (pcm[i] ?? 0) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

/** Collects samples and hands back fixed-size frames (100 ms at 16 kHz = 1600). */
export class Framer {
  /** @param {number} [frameSamples] */
  constructor(frameSamples = TARGET_RATE / 10) {
    this.size = frameSamples;
    this.buf = new Int16Array(frameSamples);
    this.fill = 0;
  }

  /** @param {Int16Array} pcm @returns {Int16Array[]} */
  push(pcm) {
    const frames = [];
    let off = 0;
    while (off < pcm.length) {
      const n = Math.min(this.size - this.fill, pcm.length - off);
      this.buf.set(pcm.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      if (this.fill === this.size) {
        frames.push(this.buf.slice());
        this.fill = 0;
      }
    }
    return frames;
  }
}

/** Mono PCM16 LE WAV file bytes. @param {Int16Array} pcm @param {number} [rate] @returns {Uint8Array} */
export function encodeWav(pcm, rate = TARGET_RATE) {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (/** @type {number} */ o, /** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return bytes;
}
