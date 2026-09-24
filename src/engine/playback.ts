// Playback clock: which frame to show while playing, from timestamps the
// caller passes in. Pure, so it is unit tested without a browser. The viewer
// and the single-file embed both drive it once per animation frame; nothing
// here reads the wall clock, and render() never sees time.

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
  /** Timestamp in ms, in the caller's clock, when playback (re)started. */
  anchorMs: number;
}

/**
 * The frame that should be on screen at `nowMs` during playback.
 *
 * Computed from the anchor every time, never accumulated per tick, so playback
 * holds real-time speed with no drift however long it runs. A timestamp earlier
 * than the anchor (an animation frame's start time can precede a clock read taken
 * in an event handler) counts as zero elapsed.
 */
export function playbackFrame(anchor: PlaybackAnchor, nowMs: number, fps: number, frameCount: number, loop = true): number {
  const elapsedMs = Math.max(0, nowMs - anchor.anchorMs);
  const frame = anchor.anchorFrame + Math.floor((elapsedMs * fps) / 1000);
  return loop ? wrapFrame(frame, frameCount) : Math.min(frame, frameCount - 1);
}

export interface Timeline {
  fps: number;
  frameCount: number;
}

/**
 * Play/pause/seek state around playbackFrame. Holds no timers; the caller runs
 * tick() once per animation frame. It loops by default. With loop off it
 * stops on the last frame, and play() from there starts again at frame 0.
 */
export class PlaybackClock {
  private currentFrame = 0;
  private isPlaying = false;
  private anchor: PlaybackAnchor = { anchorFrame: 0, anchorMs: 0 };
  private tl: Timeline | null = null;
  private readonly loop: boolean;
  private readonly now: () => number;

  constructor(now: () => number, options: { loop?: boolean } = {}) {
    this.now = now;
    this.loop = options.loop ?? true;
  }

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
      if (!this.loop && this.currentFrame === this.tl.frameCount - 1) this.currentFrame = 0;
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
    const last = this.tl.frameCount - 1;
    const next = playbackFrame(this.anchor, nowMs, this.tl.fps, this.tl.frameCount, this.loop);
    if (!this.loop && next === last) this.isPlaying = false;
    if (next === this.currentFrame) return false;
    this.currentFrame = next;
    return true;
  }

  private reanchor(): void {
    this.anchor = { anchorFrame: this.currentFrame, anchorMs: this.now() };
  }
}
