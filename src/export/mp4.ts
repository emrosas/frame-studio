// MP4 export: H.264 through WebCodecs VideoEncoder, muxed by Mediabunny,
// inside the page that draws the frames (ticket 14, "Recommendation for M3").
// The same code runs under the CLI's headless browser, in Electron and in a
// browser tab; only the sink differs. Frames go to the encoder as I420 that
// carries the export colour space, so the file decodes to the scene's colours
// in QuickTime, Chromium and ffmpeg alike (ticket 15, see color.ts). Audio,
// when there is any, is AAC or Opus from audio.ts, interleaved with the video.
//
// encodeVideo is the drawing and encoding half. A serial export feeds it
// straight into the muxer here; a parallel export runs it on one segment per
// worker and the studio server muxes the segments (ADR 0019). It restarts the
// encoder at every key frame, so both give the same file.

import { EncodedPacket } from 'mediabunny';
import { encodeAudio, type AudioCodecName, type AudioTrackSource } from './audio';
import { EXPORT_COLOR_SPACE, checkEncoderColorSpace, rgbaToI420 } from './color';
import { readPixels, type ExportOptions, type ExportRange, type FrameSource } from './frames';
import { Mp4Muxer } from './mp4-mux';
import type { ByteSink } from './sink';
import { avcCodecString, frameDurationUs, frameTimestampUs, isKeyFrame } from './timing';

/** Milliseconds spent in each stage of an export, summed over its frames. */
export interface ExportStages {
  /** Decoding picture clips before a frame draws (ADR 0014). */
  prepare: number;
  /** render(): recording the draw calls. */
  draw: number;
  /** getImageData, where Chromium rasterizes what was recorded and copies it out. */
  raster: number;
  /** RGBA to I420 and the VideoFrame around it. */
  convert: number;
  /** Waiting on the video encoder: its queue, then its flush. */
  encode: number;
  /** In the muxer, including writes to the sink. */
  mux: number;
  /** Rendering and encoding the sound. */
  audio: number;
}

export function emptyStages(): ExportStages {
  return { prepare: 0, draw: 0, raster: 0, convert: 0, encode: 0, mux: 0, audio: 0 };
}

export interface Mp4Result {
  frames: number;
  /** Video duration in microseconds: exactly frames / fps, rounded to whole microseconds. */
  durationUs: number;
  codec: string;
  /** The audio codec, when the export has sound. */
  audio?: { codec: AudioCodecName; codecString: string };
  stages: ExportStages;
}

export interface Mp4Options extends ExportOptions {
  /** Bits per second. Defaults to 8 Mb/s, plenty for 1080p line art and paint. */
  bitrate?: number;
  /** The exported frames' audio. Leave out for a silent file. */
  audio?: AudioTrackSource;
  /** Force an audio codec. By default AAC, or Opus where the browser has no AAC encoder. */
  audioCodec?: AudioCodecName;
}

/** Encoder queue depth to allow before waiting, so memory stays flat on long exports. */
const MAX_QUEUE = 4;

export const DEFAULT_BITRATE = 8_000_000;

/** The encoder config for a scene's size and rate. Throws when this browser can't encode it. */
export async function videoConfig(width: number, height: number, fps: number, bitrate = DEFAULT_BITRATE): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs VideoEncoder, so it cannot export MP4.');
  const codec = avcCodecString(width, height, fps);
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    framerate: fps,
    bitrate,
    avc: { format: 'avc' },
    latencyMode: 'quality',
    hardwareAcceleration: 'no-preference',
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`This browser cannot encode H.264 ${codec} at ${width}x${height} and ${fps} fps (${navigator.userAgent}).`);
  }
  return config;
}

export interface EncodeVideoOptions extends ExportOptions {
  config: VideoEncoderConfig;
  /**
   * The export's first frame. Timestamps and key frames count from it, so a
   * segment of a parallel export lines up with the serial file. Defaults to range.from.
   */
  origin?: number;
  /** Where each stage's time goes. */
  stages?: ExportStages;
  /** Each packet in decode order, with the decoder config on the first. Awaited one at a time, in order. */
  onPacket(packet: EncodedPacket, decoderConfig: VideoDecoderConfig | undefined): Promise<void> | void;
}

/** The bytes of a decoder config's description, as hex, to compare one encoder's with another's. */
function descriptionHex(description: AllowSharedBufferSource | undefined): string {
  if (!description) return '';
  const bytes = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Draws frames [range.from, range.to) and encodes them. Each key-frame
 * interval gets an encoder of its own, so no rate-control state crosses a key
 * frame: the packets for an interval depend only on its frames, and a
 * parallel export that splits on key frames gives the same bytes as a serial
 * one (ADR 0019). The first frame is always a key frame, and so is every
 * frame isKeyFrame picks counting from `origin`.
 */
export async function encodeVideo(source: FrameSource, range: ExportRange, options: EncodeVideoOptions): Promise<void> {
  const { width, height, fps } = source;
  const total = range.to - range.from;
  if (!(total > 0)) throw new RangeError(`nothing to export in [${range.from}, ${range.to})`);
  const origin = options.origin ?? range.from;
  const stages = options.stages ?? emptyStages();

  let failure: unknown = null;
  let rejectFailed: (err: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (rejectFailed = reject));
  failed.catch(() => {});
  const fail = (err: unknown) => {
    failure ??= err;
    rejectFailed(err);
  };
  // Packets go out in order; each waits for the one before it.
  let delivered: Promise<void> = Promise.resolve();
  /** The first encoder's description; every later encoder must write the same, since the track holds one. */
  let description: string | null = null;
  const output = (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
    let config = meta?.decoderConfig;
    if (config) {
      try {
        checkEncoderColorSpace(config.colorSpace);
        const mine = descriptionHex(config.description);
        if (description === null) description = mine;
        else if (mine !== description) throw new Error('The H.264 encoder wrote a different SPS/PPS after a key frame, so the file cannot hold one track.');
        else config = undefined;
      } catch (err) {
        fail(err);
        return;
      }
      // Mediabunny writes colr from this. Use what we asked for, not what the encoder
      // reports: VideoToolbox in Chromium 140 and 152 reports full range as limited.
      if (config) config = { ...config, colorSpace: EXPORT_COLOR_SPACE };
    }
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    const sent = config;
    delivered = delivered.then(() => options.onPacket(packet, sent)).catch(fail);
  };
  let encoder: VideoEncoder | null = null;
  /** Flushes and closes the current encoder, timing the wait as encoding. */
  const drain = async () => {
    if (!encoder) return;
    const at = performance.now();
    try {
      await Promise.race([encoder.flush(), failed]);
    } finally {
      if (encoder.state !== 'closed') encoder.close();
      encoder = null;
      stages.encode += performance.now() - at;
    }
  };
  // VideoFrame copies the planes, so one buffer serves every frame.
  const i420 = new Uint8Array((width * height * 3) / 2);

  try {
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      const frame = range.from + i;
      const n = frame - origin;
      const key = i === 0 || isKeyFrame(n, fps);
      if (key) {
        await drain();
        encoder = new VideoEncoder({ output, error: fail });
        encoder.configure(options.config);
      }
      const current = encoder!;
      let at = performance.now();
      await source.prepare?.(frame);
      let now = performance.now();
      stages.prepare += now - at;
      at = now;
      const canvas = source.draw(frame);
      now = performance.now();
      stages.draw += now - at;
      at = now;
      const pixels = readPixels(canvas);
      now = performance.now();
      stages.raster += now - at;
      at = now;
      rgbaToI420(pixels, width, height, i420);
      const video = new VideoFrame(i420, {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        timestamp: frameTimestampUs(n, fps),
        duration: frameDurationUs(n, fps),
        colorSpace: EXPORT_COLOR_SPACE,
      });
      now = performance.now();
      stages.convert += now - at;
      at = now;
      try {
        current.encode(video, { keyFrame: key });
      } finally {
        video.close();
      }
      while (current.encodeQueueSize > MAX_QUEUE) {
        await Promise.race([new Promise((resolve) => current.addEventListener('dequeue', resolve, { once: true })), failed]);
      }
      stages.encode += performance.now() - at;
      options.onProgress?.({ done: i + 1, total, stage: 'encoding' });
    }
    await drain();
    await delivered;
    if (failure) throw failure;
  } finally {
    const left = encoder as VideoEncoder | null;
    if (left && left.state !== 'closed') left.close();
  }
}

export async function exportMp4(source: FrameSource, range: ExportRange, sink: ByteSink, options: Mp4Options = {}): Promise<Mp4Result> {
  const { width, height, fps } = source;
  const total = range.to - range.from;
  if (!(total > 0)) throw new RangeError(`nothing to export in [${range.from}, ${range.to})`);
  const config = await videoConfig(width, height, fps, options.bitrate);
  const stages = emptyStages();

  if (options.audio) options.onProgress?.({ done: 0, total, stage: 'encoding audio' });
  const at = performance.now();
  const audio = options.audio ? await encodeAudio(options.audio, options.audioCodec) : null;
  stages.audio += performance.now() - at;

  const muxer = await Mp4Muxer.start(sink, { fps, frames: total, audio });
  try {
    await encodeVideo(source, range, {
      config,
      stages,
      onProgress: options.onProgress,
      onPacket: (packet, decoderConfig) => muxer.addVideo(packet, decoderConfig),
    });
    await muxer.finish();
  } catch (err) {
    await muxer.cancel();
    throw err instanceof Error ? err : new Error(String(err));
  }
  // Muxing runs while the loop waits on the encoder, so some of it shows in the encode stage too.
  stages.mux = muxer.ms;
  return {
    frames: total,
    durationUs: frameTimestampUs(total, fps),
    codec: config.codec,
    ...(audio ? { audio: { codec: audio.codec, codecString: audio.codecString } } : {}),
    stages,
  };
}
