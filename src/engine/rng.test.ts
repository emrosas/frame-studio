import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import type { Rng } from './types';

function draw(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng.next());
}

describe('createRng', () => {
  it('same seed and key give the same sequence', () => {
    expect(draw(createRng(42, 'fly'), 200)).toEqual(draw(createRng(42, 'fly'), 200));
    expect(draw(createRng(0, ''), 50)).toEqual(draw(createRng(0, ''), 50));
  });

  it('different keys give different sequences', () => {
    const a = draw(createRng(42, 'fly'), 20);
    const b = draw(createRng(42, 'bee'), 20);
    const c = draw(createRng(42, 'fly2'), 20);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(a[0]).not.toBe(b[0]);
  });

  it('different seeds give different sequences', () => {
    expect(draw(createRng(1, 'k'), 20)).not.toEqual(draw(createRng(2, 'k'), 20));
    expect(draw(createRng(12, 'k'), 20)).not.toEqual(draw(createRng(1, '2k'), 20));
  });

  it('next() stays in [0, 1)', () => {
    for (const [seed, key] of [[0, ''], [42, 'fly'], [-7, 'background'], [2 ** 31, 'x']] as const) {
      const rng = createRng(seed, key);
      for (let i = 0; i < 20000; i++) {
        const v = rng.next();
        if (!(v >= 0 && v < 1)) expect(v).toBeGreaterThanOrEqual(0);
        if (!(v < 1)) expect(v).toBeLessThan(1);
      }
    }
  });

  it('is roughly uniform', () => {
    const rng = createRng(7, 'uniform');
    const buckets = new Array(10).fill(0);
    const n = 50000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      sum += v;
      buckets[Math.floor(v * 10)]++;
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 10 - 500);
      expect(b).toBeLessThan(n / 10 + 500);
    }
  });

  it('neighbouring keys are not correlated on the first draw', () => {
    const firsts = Array.from({ length: 1000 }, (_, i) => createRng(42, `layer${i}`).next());
    const mean = firsts.reduce((a, b) => a + b, 0) / firsts.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(new Set(firsts).size).toBe(firsts.length);
  });
});

describe('fork', () => {
  it('is independent of how many numbers the parent already drew', () => {
    const fresh = createRng(42, 'fly');
    const used = createRng(42, 'fly');
    draw(used, 137);
    expect(draw(fresh.fork('wing'), 30)).toEqual(draw(used.fork('wing'), 30));
  });

  it('does not advance the parent', () => {
    const a = createRng(42, 'fly');
    const b = createRng(42, 'fly');
    draw(a.fork('wing'), 10);
    expect(draw(a, 10)).toEqual(draw(b, 10));
  });

  it('equals createRng(seed, key + "/" + k)', () => {
    expect(draw(createRng(42, 'fly').fork('wing'), 20)).toEqual(draw(createRng(42, 'fly/wing'), 20));
    expect(draw(createRng(42, 'a').fork('b').fork('c'), 20)).toEqual(draw(createRng(42, 'a/b/c'), 20));
  });

  it('rejects a fork key containing "/", which would alias a nested fork', () => {
    // fork('b/c') would hash the same input as fork('b').fork('c').
    expect(() => createRng(42, 'a').fork('b/c')).toThrow(RangeError);
    expect(() => createRng(42, 'a').fork('/')).toThrow(/may not contain "\/"/);
  });

  it('different fork keys differ from each other and from the parent', () => {
    const parent = createRng(42, 'fly');
    const a = draw(parent.fork('0'), 10);
    const b = draw(parent.fork('0.5'), 10);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(draw(createRng(42, 'fly'), 10));
  });
});

describe('helpers', () => {
  it('range(min, max) stays in [min, max)', () => {
    const rng = createRng(1, 'range');
    for (let i = 0; i < 5000; i++) {
      const v = rng.range(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
    }
  });

  it('int(min, max) returns integers in [min, max) and hits every value', () => {
    const rng = createRng(1, 'int');
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(-2, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThan(4);
      seen.add(v);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2, 3]);
  });

  it('int throws on an empty or non-integer range', () => {
    const rng = createRng(1, 'int');
    expect(() => rng.int(3, 3)).toThrow(RangeError);
    expect(() => rng.int(0, 1.5)).toThrow(RangeError);
  });

  it('pick returns items from the list and covers them all', () => {
    const rng = createRng(1, 'pick');
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('pick throws on an empty list', () => {
    expect(() => createRng(1, 'pick').pick([])).toThrow(RangeError);
  });

  it('helpers consume the same stream as next()', () => {
    const a = createRng(9, 'stream');
    const b = createRng(9, 'stream');
    const v = b.next();
    expect(a.range(10, 20)).toBe(10 + v * 10);
  });
});
