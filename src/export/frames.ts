// What an exporter needs from the thing that draws frames. The render page
// implements it with the engine; exporters never import the engine.

export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface FrameSource {
  width: number;
  height: number;
  fps: number;
  /** Draws scene frame `frame` synchronously and returns the canvas holding it. */
  draw(frame: number): FrameCanvas;
}

export interface ExportRange {
  /** First scene frame, included. */
  from: number;
  /** Last scene frame, excluded. */
  to: number;
}

export interface ExportProgress {
  /** Frames finished so far. */
  done: number;
  total: number;
  /** What is happening, e.g. "encoding" or "sampling colours". */
  stage: string;
}

export interface ExportOptions {
  onProgress?(progress: ExportProgress): void;
}

/** RGBA pixels of a canvas drawn by a FrameSource. */
export function readPixels(canvas: FrameCanvas): Uint8ClampedArray {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('the frame canvas has no 2D context');
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}
