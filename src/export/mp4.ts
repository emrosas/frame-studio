// MP4 export: H.264 through WebCodecs VideoEncoder, muxed by Mediabunny,
// inside the page that draws the frames (ticket 14, "Recommendation for M3").
// The same code runs under the CLI's headless browser, in Electron and in a
// browser tab; only the sink differs. Frames go to the encoder as I420 that
// carries the export colour space, so the file decodes to the scene's colours
// in QuickTime, Chromium and ffmpeg alike (ticket 15, see color.ts).

import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { EXPORT_COLOR_SPACE, checkEncoderColorSpace, rgbaToI420 } from './color';
import { readPixels, type ExportOptions, type ExportRange, type FrameSource } from './frames';
import type { ByteSink } from './sink';
import { avcCodecString, frameDurationUs, frameTimestampUs, isKeyFrame } from './timing';

export interface Mp4Result {
  frames: number;
  /** Video duration in microseconds: exactly frames / fps, rounded to whole microseconds. */
  durationUs: number;
  codec: string;
}

export interface Mp4Options extends ExportOptions {
  /** Bits per second. Defaults to 8 Mb/s, plenty for 1080p line art and paint. */
  bitrate?: number;
}

/** Encoder queue depth to allow before waiting, so memory stays flat on long exports. */
const MAX_QUEUE = 4;

export async function exportMp4(source: FrameSource, range: ExportRange, sink: ByteSink, options: Mp4Options = {}): Promise<Mp4Result> {
  const { width, height, fps } = source;
  const total = range.to - range.from;
  if (!(total > 0)) throw new RangeError(`nothing to export in [${range.from}, ${range.to})`);
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs VideoEncoder, so it cannot export MP4.');

  const codec = avcCodecString(width, height, fps);
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    framerate: fps,
    bitrate: options.bitrate ?? 8_000_000,
    avc: { format: 'avc' },
    latencyMode: 'quality',
    hardwareAcceleration: 'no-preference',
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`This browser cannot encode H.264 ${codec} at ${width}x${height} and ${fps} fps (${navigator.userAgent}).`);
  }

  const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => sink.write(chunk.data, chunk.position) });
  const output = new Output({
    // 'reserve' puts the index at the front, so players can start before the whole file loads,
    // while still streaming to the sink. It needs the packet count up front, which we know.
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 4 << 20 }),
  });
  const track = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(track, { frameRate: fps, maximumPacketCount: total });
  await output.start();

  let failure: unknown = null;
  let rejectFailed: (err: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (rejectFailed = reject));
  failed.catch(() => {});
  const fail = (err: unknown) => {
    failure ??= err;
    rejectFailed(err);
  };
  // Packets go to the muxer in order; each add waits for the one before it.
  let muxed: Promise<void> = Promise.resolve();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) {
        try {
          checkEncoderColorSpace(meta.decoderConfig.colorSpace);
        } catch (err) {
          fail(err);
          return;
        }
        // Mediabunny writes colr from this. Use what we asked for, not what the encoder
        // reports: VideoToolbox in Chromium 140 and 152 reports full range as limited.
        meta = { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: EXPORT_COLOR_SPACE } };
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      muxed = muxed.then(() => track.add(packet, meta)).catch(fail);
    },
    error: fail,
  });
  // VideoFrame copies the planes, so one buffer serves every frame.
  const i420 = new Uint8Array((width * height * 3) / 2);

  try {
    encoder.configure(config);
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      rgbaToI420(readPixels(source.draw(range.from + i)), width, height, i420);
      const frame = new VideoFrame(i420, {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        timestamp: frameTimestampUs(i, fps),
        duration: frameDurationUs(i, fps),
        colorSpace: EXPORT_COLOR_SPACE,
      });
      try {
        encoder.encode(frame, { keyFrame: isKeyFrame(i, fps) });
      } finally {
        frame.close();
      }
      while (encoder.encodeQueueSize > MAX_QUEUE) {
        await Promise.race([new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true })), failed]);
      }
      options.onProgress?.({ done: i + 1, total, stage: 'encoding' });
    }
    await Promise.race([encoder.flush(), failed]);
    await muxed;
    if (failure) throw failure;
    await output.finalize();
    await sink.close?.();
  } catch (err) {
    if (encoder.state !== 'closed') encoder.close();
    await output.cancel().catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (encoder.state !== 'closed') encoder.close();
  return { frames: total, durationUs: frameTimestampUs(total, fps), codec };
}
