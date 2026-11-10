// How a parallel MP4 export splits its frame range (ADR 0019). Segments are
// whole runs of key-frame intervals, counted from the export's first frame as
// the serial export counts them, so every segment opens on a key frame the
// serial file has too. Import-free, so Node loads it too.

export interface Segment {
  /** First scene frame, included. */
  from: number;
  /** Last scene frame, excluded. */
  to: number;
}

/** Frames between key frames: 2 seconds, as `isKeyFrame` in timing.ts places them. */
export function keyInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

export interface SplitOptions {
  /** Workers that will share the range. */
  workers: number;
  /** No segment shorter than this many seconds, but the last. Default 2, one key interval. */
  minSeconds?: number;
}

/**
 * Splits frames [from, to) into segments in order, each starting on a key
 * frame (a multiple of the key interval from `from`). Segments shrink as the
 * range runs out: each takes about half of what is left divided among the
 * workers, so the workers finish close together instead of one drawing the
 * last long segment alone. One segment means the export isn't worth splitting.
 */
export function splitRange(from: number, to: number, fps: number, options: SplitOptions): Segment[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) throw new RangeError(`cannot split [${from}, ${to})`);
  const interval = keyInterval(fps);
  const workers = Math.max(1, Math.floor(options.workers));
  const minIntervals = Math.max(1, Math.ceil(((options.minSeconds ?? 2) * fps) / interval));
  const intervals = Math.ceil((to - from) / interval);
  if (workers === 1 || intervals < 2 * minIntervals) return [{ from, to }];
  const out: Segment[] = [];
  let at = 0;
  while (at < intervals) {
    const left = intervals - at;
    let take = Math.max(minIntervals, Math.ceil(left / (2 * workers)));
    // Don't leave a scrap shorter than the minimum behind.
    if (left - take < minIntervals) take = left;
    out.push({ from: from + at * interval, to: Math.min(to, from + (at + take) * interval) });
    at += take;
  }
  return out;
}

/**
 * Default worker count: one per performance core, less one for the studio
 * server and the system, and no more than memory allows at about 1.5 GB a
 * worker, between 1 and 8.
 */
export function defaultWorkers(cores: number, memoryBytes: number): number {
  const byCores = Math.max(1, cores - 1);
  const byMemory = Math.max(1, Math.floor(memoryBytes / (1.5 * 2 ** 30)) - 1);
  return Math.max(1, Math.min(8, byCores, byMemory));
}

/**
 * Hands out finished segments in order. Segments finish in any order; each
 * comes out only once every segment before it has, so the muxer always gets
 * the next one.
 */
export class InOrder<T> {
  private next = 0;
  private readonly waiting = new Map<number, T>();

  /** Records segment `index` as finished and returns every segment now ready, in order. */
  done(index: number, value: T): T[] {
    if (index < this.next || this.waiting.has(index)) throw new Error(`segment ${index} finished twice`);
    this.waiting.set(index, value);
    const ready: T[] = [];
    while (this.waiting.has(this.next)) {
      ready.push(this.waiting.get(this.next)!);
      this.waiting.delete(this.next++);
    }
    return ready;
  }

  /** How many segments have come out. */
  get released(): number {
    return this.next;
  }
}
