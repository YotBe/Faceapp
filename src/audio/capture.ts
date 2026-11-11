// Microphone -> mono 16 kHz PCM16 in 100 ms frames, via the AudioWorklet.
import workletUrl from './pcm-worklet.js?worker&url';

export type Frame = { pcm: ArrayBuffer; rms: number };
export type Capture = { stop(): void; resume(): Promise<void> };

/** Must be called from inside a tap: iOS only starts audio on a user gesture. */
export async function startCapture(onFrame: (f: Frame) => void, onInterrupted: (why: string) => void): Promise<Capture> {
  const ctx = new AudioContext();
  await ctx.resume();
  await ctx.audioWorklet.addModule(workletUrl);

  // Gloss plays no sound, so there is no echo to cancel; gain control helps
  // with a speaker that is across the desk.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('The microphone gave no audio track.');
  track.addEventListener('ended', () => onInterrupted('The microphone stopped.'));
  track.addEventListener('mute', () => onInterrupted('Another app or a call took the microphone.'));

  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = ({ data }: MessageEvent<Frame>) => onFrame(data);
  // Routed to the output through a zero gain: some browsers only run a
  // worklet that leads to the destination. Nothing is audible.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);

  return {
    stop() {
      node.port.onmessage = null;
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
    resume: () => ctx.resume(),
  };
}

let wakeLock: WakeLockSentinel | undefined;
export async function holdWakeLock(): Promise<void> {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Low Power Mode refuses it; the screen may then dim and lock.
  }
}
export function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => {});
  wakeLock = undefined;
}
