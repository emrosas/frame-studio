// PROTOTYPE paper tooth for the pastel study: one fixed height field in scene pixels, shared by every pastel layer.

/**
 * The paper is a fixed texture, like a sheet of Mi-Teintes: it does not depend
 * on the scene seed or the layer, so the pits line up across every layer that
 * is drawn on it. Height 0 is the bottom of a pit, 1 the top of a ridge.
 * Pastel at pressure p lands where height > 1 - p, so p is also the fraction
 * of the paper it covers (the raw noise is flattened through its own CDF).
 */

/** Integer lattice hash to [0, 1). */
export function lattice(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) on a unit lattice. */
export function valueNoise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = x - ix;
  const ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = lattice(ix, iy, salt);
  const b = lattice(ix + 1, iy, salt);
  const c = lattice(ix, iy + 1, salt);
  const d = lattice(ix + 1, iy + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Raw height: a coarse grain, a faint horizontal laid ridge, and a fine speckle. */
function rawHeight(x: number, y: number): number {
  return 0.55 * valueNoise(x / 4.4, y / 4.4, 11) + 0.15 * valueNoise(x / 8, y / 3, 23) + 0.3 * valueNoise(x / 1.7, y / 1.7, 37);
}

const BINS = 256;
let cdf: Float64Array | undefined;

/** Cumulative distribution of rawHeight, sampled once at fixed points. */
function table(): Float64Array {
  if (cdf) return cdf;
  const samples = 16384;
  const counts = new Float64Array(BINS);
  for (let i = 0; i < samples; i++) {
    const v = rawHeight(lattice(i, 1, 101) * 4096, lattice(i, 2, 101) * 4096);
    counts[Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)))]++;
  }
  const out = new Float64Array(BINS + 1);
  let acc = 0;
  for (let i = 0; i < BINS; i++) {
    out[i] = acc / samples;
    acc += counts[i];
  }
  out[BINS] = 1;
  cdf = out;
  return out;
}

/** Paper height at a scene point, uniform in [0, 1]. scale > 1 makes the tooth coarser. */
export function toothHeight(x: number, y: number, scale: number): number {
  const v = rawHeight(x / scale, y / scale) * BINS;
  const t = table();
  const i = v <= 0 ? 0 : v >= BINS - 1 ? BINS - 1 : Math.floor(v);
  const f = Math.min(1, Math.max(0, v - i));
  return t[i] + (t[i + 1] - t[i]) * f;
}
