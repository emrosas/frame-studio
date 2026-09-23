import type { Rng } from './types';

/**
 * Seeded RNG. The stream is a pure function of (seed, key): the string
 * `${seed}:${key}` is hashed with cyrb128 into the 128-bit state of sfc32.
 * fork(k) is createRng(seed, key + "/" + k), so it never depends on how many
 * numbers the parent has drawn. Fork keys may not contain "/", or fork("b/c")
 * would give the same stream as fork("b").fork("c"). The validator rejects
 * "/" in layer ids for the same reason.
 */

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRng(seed: number, key: string): Rng {
  const next = sfc32(...cyrb128(`${seed}:${key}`));
  for (let i = 0; i < 15; i++) next(); // mix the hashed state before first use

  const rng: Rng = {
    next,
    range(min, max) {
      return min + next() * (max - min);
    },
    int(minInclusive, maxExclusive) {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive) || maxExclusive <= minInclusive) {
        throw new RangeError(`rng.int needs integers min < max, got (${minInclusive}, ${maxExclusive})`);
      }
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('rng.pick needs a non-empty list');
      return items[Math.floor(next() * items.length)];
    },
    fork(k) {
      if (k.includes('/')) throw new RangeError(`rng.fork key may not contain "/" (it separates fork keys), got "${k}"`);
      return createRng(seed, `${key}/${k}`);
    },
  };
  return rng;
}
