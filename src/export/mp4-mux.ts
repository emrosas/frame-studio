// The MP4 muxer both export paths share: the page muxes as it encodes, and the
// studio server muxes the segments a parallel export's workers encoded (ADR
// 0019). Mediabunny writes the file to a sink with the index up front; audio
// packets go in just ahead of the video they play under, and once the file is
// finalized the audio track gets its edit list trim and AAC roll group
// (audio-track.ts). Uses no browser API, so it runs in Node too.

import { EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { finishAudioTrack } from './audio-track';
import type { AudioCodecName } from './audio';
import { EXPORT_COLOR_SPACE } from './color';
import type { ByteSink } from './sink';

/** The encoded audio a file carries, in decode order. */
export interface MuxAudio {
  codec: AudioCodecName;
  packets: EncodedPacket[];
  decoderConfig: AudioDecoderConfig;
}

export interface Mp4MuxOptions {
  fps: number;
  /** Video packets the file will hold: one per frame. */
  frames: number;
  audio?: MuxAudio | null;
}

export class Mp4Muxer {
  /** Time spent in the muxer, in ms, for the benchmark. */
  ms = 0;
  private readonly output: Output;
  private readonly video: EncodedVideoPacketSource;
  private readonly audioTrack: EncodedAudioPacketSource | null;
  private readonly audio: MuxAudio | null;
  private readonly sink: ByteSink;
  private readonly options: Mp4MuxOptions;
  private moov: { data: Uint8Array; position: number } | null = null;
  private nextAudio = 0;
  private added = 0;

  private constructor(sink: ByteSink, options: Mp4MuxOptions) {
    this.sink = sink;
    this.options = options;
    this.audio = options.audio ?? null;
    const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => sink.write(chunk.data, chunk.position) });
    this.output = new Output({
      // 'reserve' puts the index at the front, so players can start before the whole file loads,
      // while still streaming to the sink. It needs the packet count up front, which we know.
      format: new Mp4OutputFormat({ fastStart: 'reserve', onMoov: (data, position) => void (this.moov = { data: data.slice(), position }) }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 << 20 }),
    });
    this.video = new EncodedVideoPacketSource('avc');
    this.output.addVideoTrack(this.video, { frameRate: options.fps, maximumPacketCount: options.frames });
    this.audioTrack = this.audio ? new EncodedAudioPacketSource(this.audio.codec) : null;
    if (this.audio && this.audioTrack) this.output.addAudioTrack(this.audioTrack, { maximumPacketCount: this.audio.packets.length });
  }

  static async start(sink: ByteSink, options: Mp4MuxOptions): Promise<Mp4Muxer> {
    const muxer = new Mp4Muxer(sink, options);
    await muxer.output.start();
    return muxer;
  }

  private async addAudioUntil(seconds: number): Promise<void> {
    const { audio, audioTrack } = this;
    if (!audio || !audioTrack) return;
    while (this.nextAudio < audio.packets.length && audio.packets[this.nextAudio].timestamp < seconds) {
      const first = this.nextAudio === 0;
      await audioTrack.add(audio.packets[this.nextAudio++], first ? { decoderConfig: audio.decoderConfig } : undefined);
    }
  }

  /**
   * Adds the next video packet in decode order. The first one needs the
   * decoder config; its colour space is replaced with the one the frames
   * carried, since VideoToolbox reports full range as limited.
   */
  async addVideo(packet: EncodedPacket, decoderConfig?: VideoDecoderConfig): Promise<void> {
    const start = performance.now();
    if (this.added === 0 && !decoderConfig) throw new Error('the first video packet needs its decoder config');
    await this.addAudioUntil(packet.timestamp + packet.duration);
    const meta = decoderConfig ? { decoderConfig: { ...decoderConfig, colorSpace: EXPORT_COLOR_SPACE } } : undefined;
    await this.video.add(packet, meta);
    this.added++;
    this.ms += performance.now() - start;
  }

  /** Writes the rest of the audio and the index, finishes the audio track, and closes the sink. */
  async finish(): Promise<void> {
    const start = performance.now();
    if (this.added !== this.options.frames) throw new Error(`the muxer got ${this.added} video packets, expected ${this.options.frames}`);
    await this.addAudioUntil(Infinity);
    await this.output.finalize();
    if (this.audio) {
      if (!this.moov) throw new Error('The muxer did not report its moov box, so the audio track cannot be finished.');
      const { data, position } = this.moov;
      await this.sink.write(finishAudioTrack(data, { frames: this.options.frames, fps: this.options.fps, roll: this.audio.codec === 'aac' }), position);
    }
    await this.sink.close?.();
    this.ms += performance.now() - start;
  }

  async cancel(): Promise<void> {
    await this.output.cancel().catch(() => {});
  }
}
