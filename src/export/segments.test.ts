import { describe, expect, it } from 'vitest';
import { defaultWorkers, InOrder, keyInterval, splitRange } from './segments';
import { isKeyFrame } from './timing';

describe('splitRange', () => {
  it('starts every segment on a key frame counted from the first frame, and tiles the range', () => {
    for (const [from, to, fps, workers] of [
      [0, 18_000, 30, 6],
      [0, 7_200, 24, 4],
      [12, 96, 12, 4],
      [7, 1_000, 25, 3],
      [0, 601, 30, 5],
    ] as const) {
      const segments = splitRange(from, to, fps, { workers, minSeconds: 2 });
      expect(segments[0].from).toBe(from);
      expect(segments.at(-1)!.to).toBe(to);
      for (const [i, s] of segments.entries()) {
        expect(s.to, `${from}-${to} segment ${i}`).toBeGreaterThan(s.from);
        if (i > 0) expect(s.from).toBe(segments[i - 1].to);
        expect(isKeyFrame(s.from - from, fps), `${from}-${to} at ${fps} fps, segment ${i} starts on ${s.from}`).toBe(true);
      }
    }
  });

  it('starts with large segments and ends with small ones, so workers finish together', () => {
    const segments = splitRange(0, 18_000, 30, { workers: 4 });
    const lengths = segments.map((s) => (s.to - s.from) / keyInterval(30));
    expect(lengths[0]).toBe(38); // 300 intervals / 8, rounded up
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeLessThanOrEqual(lengths[i - 1]);
    expect(lengths.at(-1)).toBe(1);
    expect(lengths.every(Number.isInteger)).toBe(true);
  });

  it('keeps short exports in one piece, and one worker always', () => {
    expect(splitRange(0, 24, 12, { workers: 4 })).toEqual([{ from: 0, to: 24 }]); // one key interval
    expect(splitRange(0, 36, 12, { workers: 4 })).toEqual([{ from: 0, to: 24 }, { from: 24, to: 36 }]);
    expect(splitRange(0, 96, 12, { workers: 4, minSeconds: 4 })).toEqual([{ from: 0, to: 48 }, { from: 48, to: 96 }]);
    expect(splitRange(0, 18_000, 30, { workers: 1 })).toEqual([{ from: 0, to: 18_000 }]);
  });

  it('never makes a segment shorter than the minimum, but the last', () => {
    for (const minSeconds of [2, 4, 6]) {
      const segments = splitRange(0, 30 * 61, 30, { workers: 8, minSeconds });
      for (const s of segments.slice(0, -1)) expect(s.to - s.from).toBeGreaterThanOrEqual(minSeconds * 30);
      expect(segments.at(-1)!.to - segments.at(-1)!.from).toBeGreaterThanOrEqual(minSeconds * 30 - 60);
    }
  });

  it('refuses an empty or backwards range', () => {
    expect(() => splitRange(10, 10, 30, { workers: 2 })).toThrow(RangeError);
    expect(() => splitRange(-1, 10, 30, { workers: 2 })).toThrow(RangeError);
  });
});

describe('defaultWorkers', () => {
  const GB = 2 ** 30;
  it('takes one per core less one, capped by memory and at 8', () => {
    expect(defaultWorkers(8, 16 * GB)).toBe(7);
    expect(defaultWorkers(8, 8 * GB)).toBe(4);
    expect(defaultWorkers(32, 128 * GB)).toBe(8);
    expect(defaultWorkers(2, 4 * GB)).toBe(1);
    expect(defaultWorkers(1, 64 * GB)).toBe(1);
  });
});

describe('InOrder', () => {
  it('releases segments only once every earlier one is in', () => {
    const order = new InOrder<string>();
    expect(order.done(2, 'c')).toEqual([]);
    expect(order.done(1, 'b')).toEqual([]);
    expect(order.done(0, 'a')).toEqual(['a', 'b', 'c']);
    expect(order.done(4, 'e')).toEqual([]);
    expect(order.done(3, 'd')).toEqual(['d', 'e']);
    expect(order.released).toBe(5);
  });

  it('refuses a segment twice', () => {
    const order = new InOrder<number>();
    order.done(0, 0);
    expect(() => order.done(0, 0)).toThrow(/twice/);
    order.done(2, 2);
    expect(() => order.done(2, 2)).toThrow(/twice/);
  });
});
