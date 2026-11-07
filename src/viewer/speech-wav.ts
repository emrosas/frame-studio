// A voice as Whisper wants it (ADR 0016): 16 kHz, mono, 16-bit WAV. The render
// worker decodes and this writes, so no shipped build needs ffmpeg. Pure.

export const SPEECH_RATE = 16000;

/** Mixes channels to one and writes them as a WAV file's bytes. */
export function speechWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const length = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    const v = Math.max(-1, Math.min(1, sum / channels.length));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
