// Audio for MP4 exports: AAC-LC through WebCodecs AudioEncoder, or Opus where
// the browser has no AAC encoder (Chromium on Linux, Firefox). Ticket 14,
// "Recommendation for M3", point 7.

import { EncodedPacket } from 'mediabunny';

/** The exported frames' audio: one array per channel, exactly as long as the frames. */
export interface AudioTrackSource {
  sampleRate: number;
  channels: readonly Float32Array[];
}

export type AudioCodecName = 'aac' | 'opus';

export interface EncodedAudio {
  codec: AudioCodecName;
  /** The WebCodecs codec string, e.g. "mp4a.40.2". */
  codecString: string;
  /** In decode order, timestamps already shifted back by the priming. */
  packets: EncodedPacket[];
  decoderConfig: AudioDecoderConfig;
  /** Samples the encoder put before the audio, which the file tells players to skip. */
  priming: number;
}

export const AUDIO_BITRATE = 128_000;

/**
 * AudioToolbox, behind Chromium's AAC encoder on macOS, primes with 2112
 * samples, and WebCodecs doesn't report it (w3c/webcodecs#626). Media
 * Foundation's count on Windows is unmeasured (ticket 14, open questions).
 */
export const AAC_PRIMING = 2112;

/** Samples per AudioData handed to the encoder: 100 ms at 48 kHz. */
const BLOCK = 4800;
const MAX_QUEUE = 8;

function config(codec: string, source: AudioTrackSource): AudioEncoderConfig {
  return { codec, sampleRate: source.sampleRate, numberOfChannels: source.channels.length, bitrate: AUDIO_BITRATE };
}

const CODECS = [
  ['aac', 'mp4a.40.2'],
  ['opus', 'opus'],
] as const;

/**
 * AAC if this browser encodes it, else Opus, or only `only` when given. Null
 * when it has no AudioEncoder or none of those codecs.
 */
export async function pickAudioCodec(
  source: AudioTrackSource,
  only?: AudioCodecName,
): Promise<{ codec: AudioCodecName; config: AudioEncoderConfig } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, codecString] of CODECS.filter(([c]) => only === undefined || c === only)) {
    const candidate = config(codecString, source);
    const support = await AudioEncoder.isConfigSupported(candidate).catch(() => ({ supported: false }));
    if (support.supported) return { codec, config: candidate };
  }
  return null;
}

/** Encodes the whole track up front; it is small next to the video. `only` forces a codec. */
export async function encodeAudio(source: AudioTrackSource, only?: AudioCodecName): Promise<EncodedAudio> {
  const picked = await pickAudioCodec(source, only);
  if (!picked) {
    const wanted = only === 'aac' ? 'AAC' : only === 'opus' ? 'Opus' : 'AAC or Opus';
    throw new Error(`This browser cannot encode ${wanted} audio (${navigator.userAgent}), so it cannot export this scene's sound.`);
  }
  const { sampleRate, channels } = source;
  const priming = picked.codec === 'aac' ? AAC_PRIMING : 0; // Opus carries its pre-skip in the stream
  // Samples per packet when the encoder leaves duration out: AAC frames are 1024, Opus defaults to 20 ms.
  const frameSize = picked.codec === 'aac' ? 1024 : sampleRate / 50;
  const packets: EncodedPacket[] = [];
  let decoderConfig: AudioDecoderConfig | null = null;
  let failure: unknown = null;
  let rejectFailed: (err: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (rejectFailed = reject));
  failed.catch(() => {});
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      // Whole samples from the encoder's microseconds, then back by the priming.
      const start = Math.round((chunk.timestamp * sampleRate) / 1e6) - priming;
      const length = chunk.duration ? Math.round((chunk.duration * sampleRate) / 1e6) : frameSize;
      packets.push(EncodedPacket.fromEncodedChunk(chunk).clone({ timestamp: start / sampleRate, duration: length / sampleRate }));
    },
    error: (err) => {
      failure ??= err;
      rejectFailed(err);
    },
  });
  try {
    encoder.configure(picked.config);
    const total = channels[0]?.length ?? 0;
    for (let at = 0; at < total; at += BLOCK) {
      if (failure) throw failure;
      const frames = Math.min(BLOCK, total - at);
      const planar = new Float32Array(frames * channels.length);
      channels.forEach((channel, c) => planar.set(channel.subarray(at, at + frames), c * frames));
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels.length,
        timestamp: Math.round((at * 1e6) / sampleRate),
        data: planar,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
      while (encoder.encodeQueueSize > MAX_QUEUE) {
        await Promise.race([new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true })), failed]);
      }
    }
    await Promise.race([encoder.flush(), failed]);
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (!decoderConfig) throw new Error(`The ${picked.codec} encoder gave no decoder config.`);
  return { codec: picked.codec, codecString: picked.config.codec, packets, decoderConfig, priming };
}
