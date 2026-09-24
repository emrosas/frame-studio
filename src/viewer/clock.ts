// Viewer clock helpers. The playback clock itself lives in the engine
// (src/engine/playback.ts), shared with the single-file embed; this file adds
// the fps meter the viewer's readout uses.

export { clampFrame, PlaybackClock, playbackFrame, wrapFrame, type PlaybackAnchor, type Timeline } from '../engine/playback';

/** Measures how many distinct frames per second actually reached the screen. */
export class FpsMeter {
  private times: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  record(nowMs: number): void {
    this.times.push(nowMs);
    this.prune(nowMs);
  }

  reset(): void {
    this.times = [];
  }

  /** Frames per second over the trailing window, or null without enough samples. */
  fps(nowMs: number): number | null {
    this.prune(nowMs);
    const n = this.times.length;
    if (n < 2) return null;
    const span = this.times[n - 1] - this.times[0];
    return span > 0 ? ((n - 1) * 1000) / span : null;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop > 0) this.times.splice(0, drop);
  }
}
