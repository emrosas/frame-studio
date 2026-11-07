// The pixel stage (ADR 0014): a scene that declares `pixel` draws on a small
// stage, size / scale, and every frame is then snapped to its palette and
// blown up with square pixels. Canvas antialiases every path, so the palette
// is what turns soft vector edges into clean pixel art; ordered dither is a
// pure function of (x, y), so a pixel stays the same when seeked to.

import type { PixelStage, Scene } from './types';

/** Size of a scene's stage: what its rigs draw on and what its coordinates mean. */
export function stageSize(scene: Pick<Scene, 'size' | 'pixel'>): [number, number] {
  const scale = scene.pixel?.scale ?? 1;
  return [scene.size[0] / scale, scene.size[1] / scale];
}

// 4x4 Bayer matrix, centred on zero, in the range -0.5 to 0.5.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
/** How far, in 0..255, dither 1 pushes a channel. */
const DITHER_SPREAD = 56;
const BITS = 5;
const LEVELS = 1 << BITS;

type Lookup = { colours: Uint8Array; nearest: Uint8Array };
const lookups = new Map<string, Lookup>();

export const isHexColour = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function lookupFor(palette: readonly string[]): Lookup {
  const key = palette.join();
  const known = lookups.get(key);
  if (known) return known;
  const colours = new Uint8Array(palette.length * 3);
  palette.forEach((hex, i) => {
    for (let c = 0; c < 3; c++) colours[i * 3 + c] = parseInt(hex.slice(1 + c * 2, 3 + c * 2), 16);
  });
  const nearest = new Uint8Array(LEVELS * LEVELS * LEVELS);
  for (let r = 0; r < LEVELS; r++) {
    for (let g = 0; g < LEVELS; g++) {
      for (let b = 0; b < LEVELS; b++) {
        const [cr, cg, cb] = [r, g, b].map((v) => ((v + 0.5) * 256) / LEVELS);
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < palette.length; i++) {
          const dr = cr - colours[i * 3];
          const dg = cg - colours[i * 3 + 1];
          const db = cb - colours[i * 3 + 2];
          // Weighted by how red the colour is, a cheap fit to how far apart colours look.
          const mean = (cr + colours[i * 3]) / 2;
          const distance = ((512 + mean) * dr * dr) / 256 + 4 * dg * dg + ((767 - mean) * db * db) / 256;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        nearest[(r << (BITS * 2)) | (g << BITS) | b] = best;
      }
    }
  }
  const lookup = { colours, nearest };
  lookups.set(key, lookup);
  return lookup;
}

const channel = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v) >> (8 - BITS);

/**
 * Snaps RGBA pixels to the palette in place, with ordered dither, and makes
 * every pixel fully opaque or fully clear. Depends only on its input.
 */
export function quantize(data: Uint8ClampedArray, width: number, height: number, pixel: Pick<PixelStage, 'palette' | 'dither'>): void {
  const { palette, dither = 0 } = pixel;
  if (!palette || palette.length === 0) return;
  const { colours, nearest } = lookupFor(palette);
  const spread = DITHER_SPREAD * dither;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      if (data[i + 3] < 128) {
        data[i + 3] = 0;
        continue;
      }
      const push = BAYER[(y & 3) * 4 + (x & 3)] * spread;
      const index = nearest[(channel(data[i] + push) << (BITS * 2)) | (channel(data[i + 1] + push) << BITS) | channel(data[i + 2] + push)];
      data[i] = colours[index * 3];
      data[i + 1] = colours[index * 3 + 1];
      data[i + 2] = colours[index * 3 + 2];
      data[i + 3] = 255;
    }
  }
}
