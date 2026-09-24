// The render page's window.studio (render.html). Types only, so the Node
// render tools can import them without pulling in browser code.

export type ExportTarget = 'mp4' | 'gif';

export interface RenderSceneInfo {
  id: string;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
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
  colours?: number;
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
export interface RenderHostBindings {
  __studioWrite?(sinkId: string, base64: string, position: number): Promise<void>;
  __studioClose?(sinkId: string): Promise<void>;
}

export interface RenderStudioApi {
  /** Always true once the page has booted, even when the scene has errors. */
  readonly ready: true;
  /** The scene this page renders, or null when it is invalid or missing. */
  readonly scene: RenderSceneInfo | null;
  /** Every problem with the requested scene or the rigs, one per line. */
  readonly errors: readonly string[];
  /** Keys of every scene in scenes/. */
  readonly scenes: readonly string[];
  readonly canvas: HTMLCanvasElement;
  /**
   * A frame number ("47") or timecode ("00:03:11") as a frame of this scene.
   * Throws when out of range. With end set, frameCount is allowed too, for the
   * excluded end of a range.
   */
  resolveFrame(text: string, end?: boolean): number;
  /** Draws frame n synchronously at scene size. Returns n. */
  renderFrame(frame: number): number;
  /** SHA-256, as hex, of the canvas RGBA bytes after drawing frame n. */
  pixelHash(frame: number): Promise<string>;
  /**
   * Draws frame n and writes it as PNG to the sink. With maxWidth, a frame
   * wider than that is scaled down to fit, for previews. Returns the byte count.
   */
  writePng(frame: number, sinkId: string, options?: { maxWidth?: number }): Promise<number>;
  /** The layer, and with parts the part, at scene pixel (x, y) on frame n. */
  hitTest(frame: number, x: number, y: number, options?: { parts?: boolean }): RenderHit;
  /** Encodes frames [from, to) and streams the file to the sink. Defaults to the whole scene. */
  exportVideo(target: ExportTarget, sinkId: string, range?: { from?: number; to?: number }): Promise<RenderExportResult>;
  /** Draws every Nth frame of [from, to) into one grid and writes it as PNG to the sink. */
  contactSheet(sinkId: string, options?: { from?: number; to?: number; every?: number; columns?: number }): Promise<ContactSheetResult>;
}
