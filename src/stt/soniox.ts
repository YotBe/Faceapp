// Soniox real-time STT over WebSocket, straight from the browser.
// Protocol per docs.soniox.com (read 2026-11-11); see DECISIONS.md.
const URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const SONIOX_MODEL = 'stt-rt-v6';

type Token = { text: string; is_final: boolean; language?: string; speaker?: string };
type Message = { tokens?: Token[]; finished?: boolean; error_code?: number; error_type?: string; error_message?: string };

export type SonioxHandlers = {
  /** Text finalised by this message, and the current not-yet-final tail. */
  onText(finalDelta: string, interim: string, speaker: string | undefined): void;
  onEndpoint(): void;
  /** `retryable`: the stream died for a reason a fresh connection can fix. */
  onClosed(reason: { message: string; retryable: boolean } | null): void;
};

export type SonioxStream = { send(pcm: ArrayBuffer): void; finish(): void; close(): void };

export function openSoniox(apiKey: string, terms: string[], h: SonioxHandlers): SonioxStream {
  // Browsers cannot set headers on a WebSocket; the key goes in the protocols
  // list. A bad key still opens: the error arrives as a frame.
  const ws = new WebSocket(URL, ['soniox-api-key', apiKey]);
  ws.binaryType = 'arraybuffer';
  let failure: { message: string; retryable: boolean } | null = null;
  let finished = false;
  let closedByUs = false;
  const backlog: ArrayBuffer[] = []; // audio captured while the socket opens

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        model: SONIOX_MODEL,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ['he', 'en'],
        enable_language_identification: true,
        enable_endpoint_detection: true,
        enable_speaker_diarization: true,
        context: {
          general: [{ key: 'domain', value: 'Edge AI hardware and computer-vision model deployment' }],
          terms,
        },
      }),
    );
    for (const pcm of backlog.splice(0)) ws.send(pcm);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Message;
    if (msg.error_code) {
      const retryable = msg.error_code === 503 || msg.error_code === 408 || msg.error_code === 413;
      const what =
        msg.error_code === 401 ? 'Soniox did not accept the API key.'
        : msg.error_code === 402 || msg.error_type === 'insufficient_funds' ? 'The Soniox account is out of credit.'
        : msg.error_code === 429 ? 'Soniox is rate-limiting this account.'
        : `Soniox error ${msg.error_code}: ${msg.error_message ?? msg.error_type ?? 'unknown'}`;
      failure = { message: what, retryable };
      return;
    }
    let finalDelta = '';
    let interim = '';
    let speaker: string | undefined;
    let endpoint = false;
    for (const t of msg.tokens ?? []) {
      if (t.text === '<end>') endpoint = true;
      else if (t.is_final) {
        finalDelta += t.text;
        speaker = t.speaker ?? speaker;
      } else interim += t.text;
    }
    if (finalDelta || interim || endpoint) h.onText(finalDelta, interim, speaker);
    if (endpoint) h.onEndpoint();
    if (msg.finished) finished = true;
  };

  ws.onclose = (ev) => {
    if (failure) h.onClosed(failure);
    else if (closedByUs || finished) h.onClosed(null);
    // 1006: dropped with no close frame (network change). Reconnect.
    else h.onClosed({ message: `Lost the connection to Soniox (${ev.code}).`, retryable: true });
  };

  return {
    send(pcm) {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      else if (ws.readyState === WebSocket.CONNECTING && backlog.length < 100) backlog.push(pcm); // ~10 s
    },
    finish() {
      closedByUs = true;
      // An empty TEXT frame ends the stream; an empty binary frame does not.
      if (ws.readyState === WebSocket.OPEN) ws.send('');
      else ws.close();
    },
    close() {
      closedByUs = true;
      ws.close();
    },
  };
}
