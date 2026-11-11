// AudioWorkletProcessor: any input -> mono 16 kHz PCM16 in ~100 ms frames + RMS.
import { downmix, Resampler, floatToPcm16, rms, Framer } from './pcm-core.js';

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate); // sampleRate: worklet global
    this.framer = new Framer();
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const pcm = floatToPcm16(this.resampler.process(downmix(channels)));
      for (const frame of this.framer.push(pcm)) {
        this.port.postMessage({ pcm: frame.buffer, rms: rms(frame) }, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
