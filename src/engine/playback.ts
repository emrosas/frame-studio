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
export function playbackFrame(
  anchor: PlaybackAnchor,
  nowMs: number,
  fps: number,
  frameCount: number,
  loop = true,
  range: LoopRange | null = null,
): number {
  const elapsed = Math.floor((Math.max(0, nowMs - anchor.anchorMs) * fps) / 1000);
  // A range only applies while playback started inside it.
  if (range && anchor.anchorFrame >= range.from && anchor.anchorFrame < range.to) {
    const offset = anchor.anchorFrame - range.from + elapsed;
    const span = range.to - range.from;
    return loop ? range.from + (offset % span) : Math.min(range.from + offset, range.to - 1);
  }
  const frame = anchor.anchorFrame + elapsed;
  return loop ? wrapFrame(frame, frameCount) : Math.min(frame, frameCount - 1);
}

/** Frames [from, to) that playback stays inside. */
export interface LoopRange {
  from: number;
  to: number;
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
  /** The range as asked for; loopRange clamps it to whatever timeline is current. */
  private requested: LoopRange | null = null;
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

  /** The range playback stays inside, clamped to the timeline; null when none. */
  get loopRange(): LoopRange | null {
    const r = this.requested;
    const count = this.tl?.frameCount ?? 0;
    if (!r) return null;
    const from = Math.max(0, r.from);
    const to = Math.min(count, r.to);
    return to - from >= 1 ? { from, to } : null;
  }

  /**
   * Keeps playback inside frames [from, to): it loops there, or stops on its
   * last frame with loop off, and play() outside it starts from `from`. The
   * range is clamped to the timeline; null, or a range with no frames, clears it.
   */
  setLoopRange(range: LoopRange | null): void {
    this.requested = range ? { from: range.from, to: range.to } : null;
    if (this.isPlaying) this.reanchor();
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
      const r = this.loopRange;
      if (r && (this.currentFrame < r.from || this.currentFrame >= r.to)) this.currentFrame = r.from;
      else if (!this.loop && this.currentFrame === (r ? r.to : this.tl.frameCount) - 1) this.currentFrame = r ? r.from : 0;
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
    const range = this.loopRange;
    const inRange = range !== null && this.anchor.anchorFrame >= range.from && this.anchor.anchorFrame < range.to;
    const last = (inRange ? range.to : this.tl.frameCount) - 1;
    const next = playbackFrame(this.anchor, nowMs, this.tl.fps, this.tl.frameCount, this.loop, range);
    if (!this.loop && next === last) this.isPlaying = false;
    if (next === this.currentFrame) return false;
    this.currentFrame = next;
    return true;
  }

  private reanchor(): void {
    this.anchor = { anchorFrame: this.currentFrame, anchorMs: this.now() };
  }
}
