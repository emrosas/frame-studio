// Playback clock for the viewer. Pure logic: callers pass in timestamps, so it
// can be unit tested without a browser. Viewer-only; the engine never sees
// wall-clock time.

/** Wraps any integer into [0, frameCount). */
export function wrapFrame(frame: number, frameCount: number): number {
  return ((frame % frameCount) + frameCount) % frameCount;
}

/** Truncates to an integer and clamps into [0, frameCount - 1]. NaN becomes 0. */
export function clampFrame(frame: number, frameCount: number): number {
  if (!Number.isFinite(frame)) return frame === Infinity ? Math.max(0, frameCount - 1) : 0;
  return Math.min(Math.max(0, frameCount - 1), Math.max(0, Math.trunc(frame)));
}

export interface PlaybackAnchor {
  /** Frame showing when playback (re)started. */
  anchorFrame: number;
  /** Timestamp (ms, performance.now() timebase) when playback (re)started. */
  anchorMs: number;
}

/**
 * The frame that should be on screen at `nowMs` during playback.
 *
 * Computed from the anchor every time, never accumulated per tick, so playback
 * holds real-time speed with no drift however long it runs. A timestamp earlier
 * than the anchor (requestAnimationFrame passes the frame's start time, which can
 * precede a performance.now() taken in an event handler) counts as zero elapsed.
 */
export function playbackFrame(anchor: PlaybackAnchor, nowMs: number, fps: number, frameCount: number): number {
  const elapsedMs = Math.max(0, nowMs - anchor.anchorMs);
  return wrapFrame(anchor.anchorFrame + Math.floor((elapsedMs * fps) / 1000), frameCount);
}

export interface Timeline {
  fps: number;
  frameCount: number;
}

/**
 * Play/pause/seek state around playbackFrame. Holds no timers; the viewer calls
 * tick() from requestAnimationFrame.
 */
export class PlaybackClock {
  private currentFrame = 0;
  private isPlaying = false;
  private anchor: PlaybackAnchor = { anchorFrame: 0, anchorMs: 0 };
  private tl: Timeline | null = null;

  constructor(private readonly now: () => number) {}

  get frame(): number {
    return this.currentFrame;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get timeline(): Timeline | null {
    return this.tl;
  }

  /**
   * Swaps the timeline (new scene, or the same scene after a hot edit). Keeps the
   * current frame when it still exists, and keeps playing from it. A null timeline
   * (no valid scene) stops playback.
   */
  setTimeline(timeline: Timeline | null): void {
    this.tl = timeline && timeline.frameCount >= 1 && timeline.fps > 0 ? timeline : null;
    if (!this.tl) {
      this.isPlaying = false;
      return;
    }
    this.currentFrame = clampFrame(this.currentFrame, this.tl.frameCount);
    if (this.isPlaying) this.reanchor();
  }

  /** Returns false when there is nothing to play. */
  play(): boolean {
    if (!this.tl) return false;
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.reanchor();
    }
    return true;
  }

  /** Freezes on the frame currently shown. */
  pause(): void {
    this.isPlaying = false;
  }

  toggle(): boolean {
    if (this.isPlaying) {
      this.pause();
      return false;
    }
    return this.play();
  }

  /** Clamps into range. Keeps playing from the new frame if playing. Returns the frame. */
  seek(frame: number): number {
    if (!this.tl) return this.currentFrame;
    this.currentFrame = clampFrame(frame, this.tl.frameCount);
    if (this.isPlaying) this.reanchor();
    return this.currentFrame;
  }

  /** Pauses, then moves by delta frames (clamped, no wrap). Returns the frame. */
  step(delta: number): number {
    this.pause();
    return this.seek(this.currentFrame + delta);
  }

  /** Advances playback to nowMs. Returns true when the frame changed. */
  tick(nowMs: number): boolean {
    if (!this.isPlaying || !this.tl) return false;
    const next = playbackFrame(this.anchor, nowMs, this.tl.fps, this.tl.frameCount);
    if (next === this.currentFrame) return false;
    this.currentFrame = next;
    return true;
  }

  private reanchor(): void {
    this.anchor = { anchorFrame: this.currentFrame, anchorMs: this.now() };
  }
}

/** Measures how many distinct frames per second actually reached the screen. */
export class FpsMeter {
  private times: number[] = [];

  constructor(private readonly windowMs = 1000) {}

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
