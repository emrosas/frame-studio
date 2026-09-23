/** PROTOTYPE watercolour study: deformed-polygon washes and pigment texture shared by the watercolor-* rigs. */
import type { Ctx2D, Rng } from '../../../engine/types';

export const TAU = Math.PI * 2;
export type Pt = readonly [number, number];

/** A local-space rectangle, used to keep texture inside the visible stage. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Standard normal sample (Box-Muller). 1 - next() keeps the log away from 0. */
export function gauss(rng: Rng): number {
  const u = 1 - rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rng.next());
}

/** False for colour params that ask for no paint. */
export function paintable(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c !== 'none' && c !== 'transparent';
}

/** A CSS colour between a and b; pct is how much of a. Chromium resolves color-mix, so any CSS colour works. */
export function mix(a: string, b: string, pct: number): string {
  const p = Math.round(Math.min(100, Math.max(0, pct)));
  return `color-mix(in srgb, ${a} ${p}%, ${b})`;
}

/**
 * A closed outline sampled into vertices. Each vertex keeps the outward normal
 * of the smooth outline it came from and its arc length, so washes can push the
 * edge in and out with low-frequency waves instead of per-vertex noise.
 * Outlines must run clockwise on screen (y down) for the normals to face out.
 */
export interface Ring {
  x: number[];
  y: number[];
  nx: number[];
  ny: number[];
  s: number[];
  perimeter: number;
  /** Optional per-vertex softness: scales how far each wash layer wanders at that vertex. 1 when absent. */
  w?: number[];
}

/** A copy of the ring with per-vertex softness from a function of position. */
export function withSoftness(ring: Ring, soft: (x: number, y: number) => number): Ring {
  return { ...ring, w: ring.x.map((x, i) => Math.max(0, soft(x, ring.y[i]))) };
}

/** Resample a closed outline at even spacing. The spacing grows if the outline would need more than maxVerts. */
export function ringFrom(points: readonly Pt[], spacing: number, maxVerts = 220): Ring {
  const n = points.length;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const step = Math.max(spacing, perimeter / maxVerts, 0.5);
  const x: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  let carry = 0;
  let walked = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = carry;
    while (d < len) {
      const t = d / len;
      x.push(a[0] + (b[0] - a[0]) * t);
      y.push(a[1] + (b[1] - a[1]) * t);
      s.push(walked + d);
      d += step;
    }
    carry = d - len;
    walked += len;
  }
  if (x.length < 3) {
    // Degenerate outline (zero size): keep three coincident points so callers never divide by zero.
    const p = points[0] ?? [0, 0];
    return { x: [p[0], p[0], p[0]], y: [p[1], p[1], p[1]], nx: [0, 1, 0], ny: [-1, 0, 1], s: [0, 0, 0], perimeter: 0 };
  }
  const m = x.length;
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < m; i++) {
    const tx = x[(i + 1) % m] - x[(i - 1 + m) % m];
    const ty = y[(i + 1) % m] - y[(i - 1 + m) % m];
    const l = Math.hypot(tx, ty) || 1;
    nx.push(ty / l);
    ny.push(-tx / l);
  }
  return { x, y, nx, ny, s, perimeter: walked };
}

/**
 * Recursive midpoint displacement (the classic generative-watercolour deform).
 * Every vertex carries its own roughness, so some stretches of edge stay calm
 * while others fray. Displacement scales with edge length, so each level adds
 * finer detail than the one before.
 */
export function fray(ring: Ring, rng: Rng, amount: number, depth: number): Ring {
  let { x, y, nx, ny, s } = ring;
  let w = ring.w;
  let rough = x.map(() => 0.25 + 1.5 * rng.next() ** 2);
  for (let d = 0; d < depth; d++) {
    const n = x.length;
    const X: number[] = [];
    const Y: number[] = [];
    const NX: number[] = [];
    const NY: number[] = [];
    const S: number[] = [];
    const R: number[] = [];
    const W: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      X.push(x[i]);
      Y.push(y[i]);
      NX.push(nx[i]);
      NY.push(ny[i]);
      S.push(s[i]);
      R.push(rough[i]);
      if (w) W.push(w[i], (w[i] + w[(i + 1) % n]) / 2);
      const len = Math.hypot(x[j] - x[i], y[j] - y[i]);
      const r = (rough[i] + rough[j]) / 2;
      const sd = len * amount * r;
      let mx = nx[i] + nx[j];
      let my = ny[i] + ny[j];
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml;
      my /= ml;
      const along = gauss(rng) * sd * 0.3;
      const across = gauss(rng) * sd;
      X.push((x[i] + x[j]) / 2 + mx * across - my * along);
      Y.push((y[i] + y[j]) / 2 + my * across + mx * along);
      NX.push(mx);
      NY.push(my);
      S.push(s[i] + len / 2);
      R.push(r * (0.7 + 0.6 * rng.next()));
    }
    x = X;
    y = Y;
    nx = NX;
    ny = NY;
    s = S;
    rough = R;
    if (w) w = W;
  }
  return { x, y, nx, ny, s, perimeter: ring.perimeter, w };
}

/** A copy of the ring pushed out along its normals (negative pulls it in). */
export function offsetRing(ring: Ring, by: number): Ring {
  return {
    ...ring,
    x: ring.x.map((v, i) => v + ring.nx[i] * by),
    y: ring.y.map((v, i) => v + ring.ny[i] * by),
  };
}

/** Every nth vertex of a ring: a cheaper outline for clipping, within a pixel or so of the original. */
export function thin(ring: Ring, stride: number): Ring {
  const k = Math.max(1, Math.round(stride));
  if (k === 1 || ring.x.length < 3 * k) return ring;
  const keep = (_: number, i: number) => i % k === 0;
  return {
    x: ring.x.filter(keep),
    y: ring.y.filter(keep),
    nx: ring.nx.filter(keep),
    ny: ring.ny.filter(keep),
    s: ring.s.filter(keep),
    perimeter: ring.perimeter,
    w: ring.w?.filter(keep),
  };
}

/** Add the ring to the current path as one closed subpath. */
export function traceRing(ctx: Ctx2D, ring: Ring): void {
  const n = ring.x.length;
  ctx.moveTo(ring.x[0], ring.y[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(ring.x[i], ring.y[i]);
  ctx.closePath();
}

/** Clockwise circle outline. */
export function circlePoints(cx: number, cy: number, r: number, count = 36): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Low-frequency edge wander for one wash layer: a mean push plus three sine waves along the outline. */
interface Wander {
  base: number;
  waves: [number, number, number][]; // [amplitude, angular frequency per px of arc, phase]
}

function wander(rng: Rng, bias: number): Wander {
  const waves: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const wavelength = 90 + rng.next() * 520;
    waves.push([0.25 + rng.next() * 0.45, TAU / wavelength, rng.next() * TAU]);
  }
  return { base: bias + gauss(rng) * 0.45, waves };
}

function wanderAt(w: Wander, s: number): number {
  let v = w.base;
  for (const [a, f, p] of w.waves) v += a * Math.sin(s * f + p);
  return v;
}

export interface WashStyle {
  color: string;
  /** Number of translucent layers. */
  layers: number;
  /** Alpha of each layer. */
  alpha: number;
  /** How far the edge wanders between layers, px. This sets the width of the soft edge. */
  spread: number;
  /** Mean edge offset in units of spread. Negative keeps the wash inside the outline. */
  bias?: number;
  /** Per-vertex jitter of each layer, px, for a ragged rather than smooth soft edge. */
  jitter?: number;
  /** Use every nth vertex for the layers. The jitter hides the lost detail and the path gets cheaper. */
  stride?: number;
  composite?: GlobalCompositeOperation;
}

/** Add one layer of a wash to the current path: the ring with its edge pushed around by a fresh wander. */
function traceLayer(ctx: Ctx2D, ring: Ring, rng: Rng, spread: number, bias: number, jitter: number, stride: number): void {
  const n = ring.x.length;
  const w = wander(rng, bias);
  let first = true;
  for (let i = 0; i < n; i += stride) {
    const k = ring.w ? ring.w[i] : 1;
    const off = k * (spread * wanderAt(w, ring.s[i]) + gauss(rng) * jitter);
    const px = ring.x[i] + ring.nx[i] * off;
    const py = ring.y[i] + ring.ny[i] * off;
    if (first) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    first = false;
  }
  ctx.closePath();
}

/**
 * Stack many translucent copies of the outline, each with its edge pushed in
 * and out by a different low-frequency wander. The core sees every layer and
 * reaches full colour; the edge sees only some, so it softens unevenly.
 * Several rings share each layer's fill, so a batch of shapes costs one fill per layer.
 */
export function wash(ctx: Ctx2D, rings: Ring | readonly Ring[], rng: Rng, style: WashStyle): void {
  const list = Array.isArray(rings) ? rings : [rings as Ring];
  if (!paintable(style.color) || style.layers <= 0 || style.alpha <= 0 || list.length === 0) return;
  const jitter = style.jitter ?? style.spread * 0.2;
  const stride = Math.max(1, Math.round(style.stride ?? 1));
  ctx.globalCompositeOperation = style.composite ?? 'source-over';
  ctx.globalAlpha = Math.min(1, style.alpha);
  ctx.fillStyle = style.color;
  for (let k = 0; k < style.layers; k++) {
    ctx.beginPath();
    for (const ring of list) traceLayer(ctx, ring, rng, style.spread, style.bias ?? 0, jitter, stride);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export interface PoolStyle {
  color: string;
  passes: number;
  alpha: number;
  /** Line width of each pass, px. */
  width: number;
  /** How far inside the outline the pooled line sits, px. */
  inset: number;
  /** Edge wander between passes, px. */
  spread: number;
  /** Chance that a stretch of edge gets no pigment in a pass, 0 to 1. */
  gaps?: number;
}

function tracePool(ctx: Ctx2D, ring: Ring, rng: Rng, style: PoolStyle): void {
  const n = ring.x.length;
  const gaps = style.gaps ?? 0.35;
  const w = wander(rng, 0);
  let drawing = false;
  let runLeft = 0;
  for (let i = 0; i <= n; i++) {
    const v = i % n;
    const off = -style.inset + style.spread * wanderAt(w, ring.s[v]);
    const px = ring.x[v] + ring.nx[v] * off;
    const py = ring.y[v] + ring.ny[v] * off;
    // A soft (blended) stretch of edge has no dried rim.
    if (ring.w && ring.w[v] > 2) {
      drawing = false;
      runLeft = 0;
      continue;
    }
    if (runLeft <= 0) {
      drawing = rng.next() > gaps;
      runLeft = 6 + rng.int(0, 40);
      if (drawing) {
        ctx.moveTo(px, py);
        runLeft--;
        continue;
      }
    }
    runLeft--;
    if (drawing) ctx.lineTo(px, py);
  }
}

/**
 * Pigment pooled along the drying edge of a wash: thin multiply strokes just
 * inside the outline, broken into stretches so the dark rim comes and goes.
 */
export function pool(ctx: Ctx2D, rings: Ring | readonly Ring[], rng: Rng, style: PoolStyle): void {
  const list = Array.isArray(rings) ? rings : [rings as Ring];
  if (!paintable(style.color) || style.passes <= 0 || style.alpha <= 0 || style.width <= 0 || list.length === 0) return;
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = Math.min(1, style.alpha);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let k = 0; k < style.passes; k++) {
    ctx.beginPath();
    for (const ring of list) tracePool(ctx, ring, rng, style);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** Smooth 2D value noise in [0, 1], tiled every 64 cells. */
export function valueNoise(rng: Rng, cell: number): (x: number, y: number) => number {
  const N = 64;
  const table: number[] = [];
  for (let i = 0; i < N * N; i++) table.push(rng.next());
  const size = Math.max(cell, 1e-3);
  const at = (i: number, j: number) => table[(((i % N) + N) % N) + N * (((j % N) + N) % N)];
  return (x, y) => {
    const gx = x / size;
    const gy = y / size;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    let fx = gx - ix;
    let fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx;
    return a + (b - a) * fy;
  };
}

export interface SpeckStyle {
  color: string;
  alpha: number;
  /** Specks per 1000 square px before the noise mask thins them. */
  density: number;
  size: [number, number];
  composite?: GlobalCompositeOperation;
  /** Optional clustering mask in [0, 1]; a speck survives with probability mask^2 * 1.8. */
  mask?: (x: number, y: number) => number;
  /** Upper bound on specks, to keep huge areas cheap. */
  max?: number;
}

/**
 * Pigment granulation or paper tooth: tiny squares batched into one path and
 * one fill. Squares, not arcs, because one rect() is one path segment.
 */
export function specks(ctx: Ctx2D, rng: Rng, box: Box, style: SpeckStyle): void {
  if (!paintable(style.color) || style.alpha <= 0 || style.density <= 0) return;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (!(w > 0 && h > 0)) return;
  const count = Math.min(style.max ?? 6000, Math.round((w * h * style.density) / 1000));
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = box.x0 + rng.next() * w;
    const y = box.y0 + rng.next() * h;
    const size = style.size[0] + rng.next() * (style.size[1] - style.size[0]);
    const keep = rng.next();
    if (style.mask) {
      const m = style.mask(x, y);
      if (keep > m * m * 1.8) continue;
    }
    ctx.rect(x, y, size, size * (0.6 + 0.8 * rng.next()));
  }
  ctx.globalCompositeOperation = style.composite ?? 'source-over';
  ctx.globalAlpha = Math.min(1, style.alpha);
  ctx.fillStyle = style.color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Outline of a cauliflower bloom: a lopsided circle whose edge is a run of
 * rounded scallops with cusps pointing inward, lightly frayed.
 */
export function bloomRing(rng: Rng, cx: number, cy: number, r: number): Ring {
  const pts: Pt[] = [];
  const lobes: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) lobes.push([1 + rng.int(0, 4), 0.06 + rng.next() * 0.12, rng.next() * TAU]);
  const scallops = 9 + rng.int(0, 10);
  const depth: number[] = [];
  for (let k = 0; k < scallops; k++) depth.push(0.05 + rng.next() * 0.1);
  const count = 96;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    let rr = 1;
    for (const [f, amp, ph] of lobes) rr += amp * Math.sin(f * a + ph);
    const u = (a / TAU) * scallops;
    const k = Math.floor(u);
    rr -= depth[k % scallops] * (1 - Math.sin(Math.PI * (u - k)));
    pts.push([cx + Math.cos(a) * r * rr, cy + Math.sin(a) * r * rr]);
  }
  return fray(ringFrom(pts, Math.max(1, r / 14), 80), rng, 0.08, 1);
}

/**
 * Cauliflower blooms (backruns): water flooding back into a drying wash pushes
 * pigment outward, leaving a paler centre ringed by a hard, frilly dark edge.
 */
export function blooms(ctx: Ctx2D, rng: Rng, rings: readonly Ring[], r: number, lift: string, rim: string, strength: number): void {
  if (rings.length === 0 || strength <= 0) return;
  wash(ctx, rings, rng, { color: lift, layers: 4, alpha: 0.07 * strength, spread: r * 0.2, bias: -1 });
  pool(ctx, rings, rng, { color: rim, passes: 3, alpha: 0.35 * strength, width: 1.4, inset: 0.3, spread: 0.7, gaps: 0.25 });
}

export interface StreakStyle {
  color: string;
  alpha: number;
  width: number;
  composite?: GlobalCompositeOperation;
}

/** One dry-brush drag: a gently bent line broken into 1 to 4 dashes where the brush skipped the paper tooth. */
export function streakPath(ctx: Ctx2D, rng: Rng, x: number, y: number, len: number, angle: number): void {
  const dx = Math.sin(angle);
  const dy = Math.cos(angle);
  const bend = gauss(rng) * len * 0.06;
  const pieces = 1 + rng.int(0, 4);
  let t = 0;
  for (let k = 0; k < pieces && t < 1; k++) {
    const seg = (0.15 + rng.next() * 0.5) * (1 - t);
    const t1 = Math.min(1, t + seg);
    const at = (u: number): [number, number] => {
      const b = bend * 4 * u * (1 - u);
      return [x + dx * len * u + dy * b, y + dy * len * u - dx * b];
    };
    const [ax, ay] = at(t);
    const [mx, my] = at((t + t1) / 2);
    const [bx, by] = at(t1);
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(mx, my, bx, by);
    t = t1 + 0.04 + rng.next() * 0.2;
  }
}

/** A tapered brush line along a quadratic curve, filled as a ribbon so both ends come to a point. */
export function taperedStroke(
  ctx: Ctx2D,
  p0: Pt,
  c: Pt,
  p1: Pt,
  width: number,
  steps = 14,
): void {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = (1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0];
    const y = (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1];
    const tx = 2 * (1 - u) * (c[0] - p0[0]) + 2 * u * (p1[0] - c[0]);
    const ty = 2 * (1 - u) * (c[1] - p0[1]) + 2 * u * (p1[1] - c[1]);
    const l = Math.hypot(tx, ty) || 1;
    const half = (width / 2) * (0.35 + 0.65 * Math.sin(Math.PI * u) ** 0.6);
    left.push([x - (ty / l) * half, y + (tx / l) * half]);
    right.push([x + (ty / l) * half, y - (tx / l) * half]);
  }
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
}

/**
 * One dry-brush fleck: a thin spindle along a gently bent line, widest a
 * little after the brush touched down and running out to a point. Added to
 * the current path so thousands of flecks cost one fill.
 */
export function fleckPath(ctx: Ctx2D, rng: Rng, x: number, y: number, len: number, angle: number, width: number): void {
  const dx = Math.sin(angle);
  const dy = Math.cos(angle);
  const bend = gauss(rng) * len * 0.03;
  const peak = 0.25 + rng.next() * 0.4;
  const steps = 4;
  const lx: number[] = [];
  const ly: number[] = [];
  const rx: number[] = [];
  const ry: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const b = bend * 4 * u * (1 - u);
    const cx = x + dx * len * u + dy * b;
    const cy = y + dy * len * u - dx * b;
    const shape = u < peak ? Math.sin(((u / peak) * Math.PI) / 2) : Math.cos((((u - peak) / (1 - peak)) * Math.PI) / 2);
    const half = (width / 2) * Math.max(0, shape) ** 0.4 * (0.8 + 0.4 * rng.next());
    lx.push(cx + dy * half);
    ly.push(cy - dx * half);
    rx.push(cx - dy * half);
    ry.push(cy + dx * half);
  }
  ctx.moveTo(lx[0], ly[0]);
  for (let i = 1; i <= steps; i++) ctx.lineTo(lx[i], ly[i]);
  for (let i = steps; i >= 0; i--) ctx.lineTo(rx[i], ry[i]);
  ctx.closePath();
}

/**
 * A scribbled fill: short brush arcs curling round random points inside an
 * ellipse, the way a pale patch gets rubbed in with a small round brush.
 * Each arc stays inside the ellipse. Added to the current path.
 */
export function scribblePath(ctx: Ctx2D, rng: Rng, cx: number, cy: number, rx: number, ry: number, count: number): void {
  const n = Math.max(1, Math.round(count));
  const steps = 10;
  for (let i = 0; i < n; i++) {
    const d = 0.65 * Math.sqrt(rng.next());
    const at = rng.next() * TAU;
    const k = (1 - d) * (0.45 + 0.55 * rng.next());
    const ox = cx + Math.cos(at) * rx * d;
    const oy = cy + Math.sin(at) * ry * d;
    const a0 = rng.next() * TAU;
    const sweep = (0.8 + rng.next() * 1.6) * (rng.next() < 0.5 ? 1 : -1);
    const squash = 0.7 + rng.next() * 0.6;
    for (let j = 0; j <= steps; j++) {
      const a = a0 + (sweep * j) / steps;
      const px = ox + Math.cos(a) * rx * k;
      const py = oy + Math.sin(a) * ry * k * squash;
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
}
