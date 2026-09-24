// Live sound for the viewer and the single-file embed. Both play the scene's
// pre-rendered buffer (render.ts), so what you hear while previewing is what
// the export encodes. The caller owns the clock: it calls update() with the
// playhead whenever it draws, and this keeps a buffer source in step, starting
// over on play, seek, a loop change or drift. Read the playhead when calling
// update(), not at the start of the animation frame, or the time spent
// drawing counts as drift.

/** Where the caller's playback is, in seconds of scene time. */
export interface Playhead {
  playing: boolean;
  /** Scene time now, unquantized (PlaybackClock.position divided by fps). */
  seconds: number;
  /** The span playback loops through, [from, to) in seconds. */
  loop: { from: number; to: number };
  /** False when playback stops at loop.to instead of wrapping (an embed with loop=0). */
  repeat: boolean;
}

/** How far sound may drift from the picture before it starts over, in seconds. */
export const DRIFT_TOLERANCE = 0.04;

interface Voice {
  source: AudioBufferSourceNode;
  /** Context time the source started. */
  startedAt: number;
  /** Buffer offset it started from. */
  offset: number;
  loopFrom: number;
  loopTo: number;
  repeat: boolean;
}

export class LivePlayback {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private voice: Voice | null = null;
  private muted = false;
  private readonly createContext: () => AudioContext;

  constructor(createContext: () => AudioContext) {
    this.createContext = createContext;
  }

  /**
   * Browsers keep sound off until the person interacts with the page. Call
   * this from a click or key handler; it creates or resumes the context.
   */
  unlock(): Promise<void> {
    this.ctx ??= this.createContext();
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  /** True once the browser lets the context play. */
  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** The scene's rendered audio, or null for silence. Stops what is playing. */
  setBuffer(buffer: AudioBuffer | null): void {
    if (buffer === this.buffer) return;
    this.stop();
    this.buffer = buffer;
  }

  get hasSound(): boolean {
    return this.buffer !== null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Scene time reaching the speakers now, in seconds, or null when nothing is playing. */
  get heardSeconds(): number | null {
    return this.voice && this.ctx ? this.heard(this.voice, this.ctx) : null;
  }

  /** Starts, stops or resyncs the sound to the playhead. Cheap when nothing changed. */
  update(head: Playhead): void {
    const ctx = this.ctx;
    const buffer = this.buffer;
    if (!head.playing || !buffer || this.muted || !ctx || ctx.state !== 'running') {
      this.stop();
      return;
    }
    const from = Math.max(0, Math.min(head.loop.from, buffer.duration));
    const to = Math.max(from, Math.min(head.loop.to, buffer.duration));
    if (to - from <= 0) {
      this.stop();
      return;
    }
    const voice = this.voice;
    if (voice && voice.loopFrom === from && voice.loopTo === to && voice.repeat === head.repeat) {
      const heard = this.heard(voice, ctx);
      const drift = head.repeat ? wrappedDifference(heard, head.seconds, to - from) : heard - head.seconds;
      if (Math.abs(drift) <= DRIFT_TOLERANCE) return;
    }
    this.start(ctx, buffer, head, from, to);
  }

  stop(): void {
    const voice = this.voice;
    this.voice = null;
    if (!voice) return;
    try {
      voice.source.stop();
    } catch {
      // never started, or already stopped
    }
    voice.source.disconnect();
  }

  /** Stops and closes the context. */
  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private latency(ctx: AudioContext): number {
    return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  }

  /** Scene time reaching the speakers now. */
  private heard(voice: Voice, ctx: AudioContext): number {
    const played = voice.offset + (ctx.currentTime - voice.startedAt) - this.latency(ctx);
    return voice.repeat ? wrapInto(played, voice.loopFrom, voice.loopTo) : played;
  }

  private start(ctx: AudioContext, buffer: AudioBuffer, head: Playhead, from: number, to: number): void {
    this.stop();
    // Start ahead by the output latency, so the sound reaching the speakers matches the picture.
    const ahead = head.seconds + this.latency(ctx);
    if (!head.repeat && ahead >= to) return; // the end is already on its way out
    const offset = head.repeat ? wrapInto(ahead, from, to) : Math.max(from, ahead);
    const source = new AudioBufferSourceNode(ctx, { buffer, loop: head.repeat, loopStart: from, loopEnd: to });
    source.connect(ctx.destination);
    const startedAt = ctx.currentTime;
    // Played once, the source stops by itself at the end, even if the page stops calling update().
    if (head.repeat) source.start(startedAt, offset);
    else source.start(startedAt, offset, to - offset);
    this.voice = { source, startedAt, offset, loopFrom: from, loopTo: to, repeat: head.repeat };
  }
}

/** Wraps t into [from, to). */
export function wrapInto(t: number, from: number, to: number): number {
  const span = to - from;
  if (span <= 0) return from;
  return from + ((((t - from) % span) + span) % span);
}

/** a - b on a loop of length span, the short way round. */
export function wrappedDifference(a: number, b: number, span: number): number {
  const d = (((a - b) % span) + span) % span;
  return d > span / 2 ? d - span : d;
}
