// The render page's window.studio (render.html). Types only, so the Node
// render tools can import them without pulling in browser code.

import type { CheckReport } from '../export/check.ts';
import type { ExportStages } from '../export/mp4.ts';

export type { ExportStages };

export type ExportTarget = 'mp4' | 'gif';

export interface RenderSceneInfo {
  id: string;
  /** The folder under out/ its files go to: the id, or "<project>/<id>" for a project scene. */
  out: string;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  /** Whether the scene has audio cues. */
  audio: boolean;
}

export interface RenderExportResult {
  target: ExportTarget;
  from: number;
  to: number;
  frames: number;
  /** Duration the file declares, in seconds. */
  seconds: number;
  ms: number;
  codec?: string;
  /** The audio codec string when the MP4 has sound, e.g. "mp4a.40.2" or "opus". GIFs are always silent. */
  audioCodec?: string;
  colours?: number;
  /** Where an MP4 export's time went, in ms summed over its frames. */
  stages?: ExportStages;
  /** Render workers that shared an MP4 export; 1 when one page made it alone (ADR 0019). */
  workers?: number;
  /** Segments a parallel export was split into. */
  segments?: number;
}

/** One segment of a parallel MP4 export, encoded by one worker (ADR 0019). */
export interface SegmentResult {
  from: number;
  to: number;
  origin: number;
  frames: number;
  codec: string;
  ms: number;
  stages: ExportStages;
}

/** A parallel export's sound, rendered and encoded once (ADR 0005). */
export interface AudioTrackResult {
  codec: 'aac' | 'opus';
  codecString: string;
  packets: number;
  ms: number;
}

export interface RenderHit {
  layerId: string | null;
  partId?: string;
  /** Layers with paint at the pixel, top first, with their share of it. */
  candidates: { layerId: string; alpha: number; share: number }[];
}

export interface ContactSheetResult {
  frames: number[];
  width: number;
  height: number;
}

/**
 * Bytes leave the page through a host function, window.__studioWrite, that
 * the host installs before the page loads (the CLI uses Playwright's
 * exposeFunction). Each call carries a sink id, base64 data and a byte offset.
 * window.__studioClose(sinkId) follows the last write.
 */
export interface RenderStudioApi {
  /** Always true once the page has booted, even when the scene has errors. */
  readonly ready: true;
  /** The scene this page renders, or null when it is invalid or missing. */
  readonly scene: RenderSceneInfo | null;
  /** Every problem with the requested scene or the rigs, one per line. */
  readonly errors: readonly string[];
  /** Keys of every scene in the studio folder. */
  readonly scenes: readonly string[];
  readonly canvas: HTMLCanvasElement;
  /** Lets go of decoded picture clips, when the worker drops this page's scene. */
  dispose(): void;
  /**
   * A frame number ("47") or timecode ("00:03:11") as a frame of this scene.
   * Throws when out of range. With end set, frameCount is allowed too, for the
   * excluded end of a range.
   */
  resolveFrame(text: string, end?: boolean): number;
  /** Draws frame n synchronously at scene size. Returns n. */
  renderFrame(frame: number): Promise<number>;
  /** SHA-256, as hex, of the scene's rendered audio (float32 samples, channel after channel). Null for a silent scene. */
  audioHash(): Promise<string | null>;
  /** Samples [from, to) of one channel of the scene's rendered audio, for tests. Empty for a silent scene. Keep ranges short. */
  audioSamples(from: number, to: number, channel?: number): Promise<number[]>;
  /** The loudest sample, as an absolute value, in [from, to) across every channel. 0 for a silent scene. For tests. */
  audioPeak(from: number, to: number): Promise<number>;
  /**
   * Renders the scene's audio again, counting connections into each node input, and returns the most any
   * input got. Two at most keeps renders identical (ticket 04). For tests.
   */
  audioFanIn(): Promise<number>;
  /** SHA-256, as hex, of the canvas RGBA bytes after drawing frame n. */
  pixelHash(frame: number): Promise<string>;
  /**
   * Draws frame n and writes it as PNG to the sink. With maxWidth, a frame
   * wider than that is scaled down to fit, for previews. Returns the byte count.
   */
  writePng(frame: number, sinkId: string, options?: { maxWidth?: number }): Promise<number>;
  /** The layer, and with parts the part, at scene pixel (x, y) on frame n. */
  hitTest(frame: number, x: number, y: number, options?: { parts?: boolean }): Promise<RenderHit>;
  /**
   * Encodes frames [from, to) and streams the file to the sink. Defaults to
   * the whole scene. MP4s carry the scene's audio for that range unless
   * silent, as AAC, or Opus where there is no AAC encoder; audioCodec forces one.
   */
  exportVideo(
    target: ExportTarget,
    sinkId: string,
    options?: { from?: number; to?: number; silent?: boolean; audioCodec?: 'aac' | 'opus' },
  ): Promise<RenderExportResult>;
  /**
   * Draws and encodes frames [from, to) with a fresh H.264 encoder and writes
   * the packets to the sink as records (src/export/packets.ts), for the server
   * to mux (ADR 0019). Timestamps and key frames count from `origin`, the
   * export's first frame; the segment's first frame is always a key frame.
   */
  encodeSegment(sinkId: string, options: { from: number; to: number; origin?: number; bitrate?: number }): Promise<SegmentResult>;
  /** Encodes the scene's sound for frames [from, to) and writes the packets to the sink as records. Null for a silent scene. */
  encodeAudioTrack(sinkId: string, options?: { from?: number; to?: number; audioCodec?: 'aac' | 'opus' }): Promise<AudioTrackResult | null>;
  /**
   * Measures frames [from, to), drawn small, and the scene's rendered audio: every check in src/export/check.ts.
   * Defaults to the whole scene. With loop, the seam between the last and first frames is judged too.
   */
  check(options?: { from?: number; to?: number; loop?: boolean }): Promise<CheckReport>;
  /** Decodes a sound file from media/ to 16 kHz mono and writes it to the sink as a WAV, for the timing job (ADR 0016). Returns the seconds. */
  writeSpeech(file: string, sinkId: string): Promise<number>;
  /** Draws every Nth frame of [from, to) into one grid and writes it as PNG to the sink. */
  contactSheet(sinkId: string, options?: { from?: number; to?: number; every?: number; columns?: number }): Promise<ContactSheetResult>;
}
