// GIF palette building and colour mapping (ticket 14, "GIF"). gifenc's own
// quantizer works in 5-6-5 bits and tinted the white bear to 251,251,246, so
// the most frequent colours are kept exact and only the remaining slots come
// from the quantizer. Pure, so it is unit tested without a browser.

import { quantize } from 'gifenc';

export type Rgb = [number, number, number];

export interface SamplerOptions {
  /** Histogram every pixelStep-th pixel. */
  pixelStep?: number;
  /** Of the histogram pixels, feed every quantizeEvery-th to the quantizer. */
  quantizeEvery?: number;
}

export interface BuildOptions {
  /** Palette size. 255 leaves one of GIF's 256 slots for the transparent "unchanged" index. */
  maxColors?: number;
  /** How many of the most frequent colours are kept exact when the frames hold more colours than maxColors. */
  exactSlots?: number;
}

export interface PaletteSampler {
  /** Adds one frame of RGBA pixels. Alpha is ignored. */
  add(rgba: Uint8Array | Uint8ClampedArray): void;
  /** The palette, most frequent exact colours first. Throws when nothing was added. */
  build(options?: BuildOptions): Rgb[];
}

const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const unkey = (k: number): Rgb => [k >> 16, (k >> 8) & 255, k & 255];

export function createPaletteSampler({ pixelStep = 2, quantizeEvery = 4 }: SamplerOptions = {}): PaletteSampler {
  const counts = new Map<number, number>();
  const chunks: Uint8Array[] = [];
  let sampled = 0;
  return {
    add(rgba) {
      const pixels = rgba.length >> 2;
      const chunk = new Uint8Array(Math.ceil(pixels / pixelStep / quantizeEvery) * 4);
      let c = 0;
      for (let p = 0; p < pixels; p += pixelStep) {
        const i = p * 4;
        const k = key(rgba[i], rgba[i + 1], rgba[i + 2]);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        if (sampled++ % quantizeEvery === 0 && c < chunk.length) {
          chunk[c] = rgba[i];
          chunk[c + 1] = rgba[i + 1];
          chunk[c + 2] = rgba[i + 2];
          chunk[c + 3] = 255;
          c += 4;
        }
      }
      chunks.push(chunk.subarray(0, c));
    },
    build({ maxColors = 255, exactSlots = 128 } = {}) {
      if (counts.size === 0) throw new Error('cannot build a palette from no pixels');
      const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([k]) => unkey(k));
      if (byFrequency.length <= maxColors) return byFrequency;
      const exact = byFrequency.slice(0, Math.min(exactSlots, maxColors));
      const sample = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
      let offset = 0;
      for (const ch of chunks) {
        sample.set(ch, offset);
        offset += ch.length;
      }
      const palette = [...exact];
      const seen = new Set(exact.map(([r, g, b]) => key(r, g, b)));
      const push = ([r, g, b]: readonly number[]) => {
        const k = key(r, g, b);
        if (palette.length < maxColors && !seen.has(k)) {
          seen.add(k);
          palette.push([r, g, b]);
        }
      };
      quantize(sample, maxColors - exact.length, { format: 'rgb565' }).forEach(push);
      // The quantizer can return fewer colours than asked; spend any spare slots on the next most frequent exact ones.
      for (let i = exact.length; i < byFrequency.length && palette.length < maxColors; i++) push(byFrequency[i]);
      return palette;
    },
  };
}

/** Marks an empty slot in the mapper's cache; palettes stop at index 254. */
const UNCACHED = 255;

/**
 * Maps a colour to the nearest palette index, weighing channels 2:4:3 for
 * red, green and blue, and caching every answer. A palette colour maps to its
 * own index. The cache is one byte per 24-bit colour, 16 MB, so memory stays
 * flat however many colours the frames hold. The palette holds at most 255
 * colours, which leaves index 255 for GIF's transparent slot.
 */
export function createColorMapper(palette: readonly Rgb[]): (r: number, g: number, b: number) => number {
  if (palette.length > UNCACHED) throw new RangeError(`a palette holds at most 255 colours, got ${palette.length}`);
  const cache = new Uint8Array(1 << 24).fill(UNCACHED);
  return (r, g, b) => {
    const k = key(r, g, b);
    const hit = cache[k];
    if (hit !== UNCACHED) return hit;
    let best = 0;
    let bestDistance = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const [pr, pg, pb] = palette[j];
      const d = 2 * (pr - r) ** 2 + 4 * (pg - g) ** 2 + 3 * (pb - b) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
        if (d === 0) break;
      }
    }
    cache[k] = best;
    return best;
  };
}

/** Palette indices for RGBA pixels, written into `out` when given. */
export function indexPixels(
  rgba: Uint8Array | Uint8ClampedArray,
  map: (r: number, g: number, b: number) => number,
  out = new Uint8Array(rgba.length >> 2),
): Uint8Array {
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = map(rgba[i], rgba[i + 1], rgba[i + 2]);
  return out;
}

/**
 * `cur` with every pixel that equals `prev` set to `transparentIndex`, so the
 * GIF only stores changes. Written into `out` when given; the inputs are left alone.
 */
export function markUnchanged(cur: Uint8Array, prev: Uint8Array, transparentIndex: number, out = new Uint8Array(cur.length)): Uint8Array {
  for (let p = 0; p < cur.length; p++) out[p] = cur[p] === prev[p] ? transparentIndex : cur[p];
  return out;
}
