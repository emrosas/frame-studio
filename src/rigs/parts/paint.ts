/**
 * Paint toolkit for rigs that want a hand-painted gouache look.
 *
 * - Brush collects stroked bristle marks and Marks collects filled marks.
 *   Both batch by colour, alpha, width and blend mode, so thousands of marks
 *   cost a few dozen canvas calls in the browser and in the test recorder.
 * - dryStroke, ragEdge and edgeFlicks make dry-brush marks and ragged paint
 *   edges. Marks.spindle and Marks.ribbon make tapered marks and brush lines.
 * - wash lays soft-edged layered fills (shadows, patches), and brokenRim adds
 *   a thin darker line that comes and goes just inside an outline.
 * - The outline helpers (resample, normals, offsets, eggs, wobble) build the
 *   shapes those marks follow.
 *
 * Everything draws in the caller's current transform, and every random choice
 * comes from the Rng the caller passes in. Fork it per feature so tuning one
 * feature does not reshuffle the others.
 */
import type { Ctx2D, Rng } from '../../engine/types';
import { TAU, clamp } from './math';

export type Pt = [number, number];

/** Axis-aligned box in the caller's coordinates. Marks wholly outside it are dropped. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds that cull nothing, for marks that must always draw. */
export const EVERYWHERE: Bounds = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ colour */

type Rgb = readonly [number, number, number];

/** Parses hex (3, 4, 6 or 8 digits), rgb()/rgba() with plain numbers, white and black. Anything else is null. */
function parseColor(color: string): Rgb | null {
  const c = color.trim().toLowerCase();
  if (c === 'white') return [255, 255, 255];
  if (c === 'black') return [0, 0, 0];
  let m = /^#([\da-f])([\da-f])([\da-f])[\da-f]?$/.exec(c);
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
  m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/.exec(c);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

const hex2 = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');

/**
 * Colour `a` blended toward `b` by t (0 gives a, 1 gives b). Hex and rgb()
 * colours mix to a hex string. Any other CSS colour falls back to a
 * color-mix() string, which the canvas resolves.
 */
export function mixColor(a: string, b: string, t: number): string {
  const k = clamp(t, 0, 1);
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (pa && pb) return `#${hex2(lerp(pa[0], pb[0], k))}${hex2(lerp(pa[1], pb[1], k))}${hex2(lerp(pa[2], pb[2], k))}`;
  return `color-mix(in srgb, ${a} ${Math.round((1 - k) * 100)}%, ${b})`;
}

/** False for colours that ask for no paint. */
export function paintable(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c !== 'none' && c !== 'transparent';
}

/* ------------------------------------------------------------------ noise */

/** Smooth 2D value noise with cells `cell` pixels wide, tiled every 32 cells. Values in [0, 1]. */
export function noise2(rng: Rng, cell: number): (x: number, y: number) => number {
  const N = 32;
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
    const top = lerp(at(ix, iy), at(ix + 1, iy), fx);
    const bottom = lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx);
    return lerp(top, bottom, fy);
  };
}

/** A standard normal sample. */
export function gauss(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(TAU * rng.next());
}

/* ------------------------------------------------------------------ outlines */

/** Twice the signed area of a closed polygon. Negative means counter-clockwise on screen (y down). */
export function signedArea(pts: readonly Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  return area;
}

/** Resamples a closed polygon to points roughly `step` apart. */
export function resample(pts: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const k = clamp(Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(0.5, step)), 1, 400);
    for (let j = 0; j < k; j++) out.push([lerp(x0, x1, j / k), lerp(y0, y1, j / k)]);
  }
  return out;
}

/** Outward unit normals of a closed polygon, whichever way it winds. */
export function outwardNormals(pts: readonly Pt[]): Pt[] {
  const sign = signedArea(pts) > 0 ? 1 : -1;
  const n = pts.length;
  return pts.map((_, i) => {
    const [ax, ay] = pts[(i - 1 + n) % n];
    const [bx, by] = pts[(i + 1) % n];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    // With y down, a positive-area loop has its outside on the left of travel.
    return [(sign * (by - ay)) / l, (-sign * (bx - ax)) / l] as Pt;
  });
}

/** Moves every point along its normal by d(i). Negative moves inward. */
export function offsetPoly(pts: readonly Pt[], normals: readonly Pt[], d: (i: number) => number): Pt[] {
  return pts.map(([x, y], i) => {
    const k = d(i);
    return [x + normals[i][0] * k, y + normals[i][1] * k] as Pt;
  });
}

/** Adds a closed polygon to the current path. */
export function tracePoly(ctx: Ctx2D, pts: readonly Pt[]): void {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Fills a closed polygon with one colour. */
export function fillPoly(ctx: Ctx2D, pts: readonly Pt[], color: string): void {
  if (pts.length < 3 || !paintable(color)) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  tracePoly(ctx, pts);
  ctx.fill();
}

/** Shape of an egg outline. Every field is optional. */
export interface EggShape {
  /** Above 0 narrows the top half toward the top; below 0 narrows the bottom half toward the bottom. */
  taper?: number;
  /** 2 is an ellipse, higher is boxier. */
  squareness?: number;
  /** Moves the widest point up by this fraction of ry (negative moves it down). The top and bottom stay put. */
  lift?: number;
  /** Turn in radians, clockwise on screen. */
  rotation?: number;
}

/**
 * An egg: a superellipse centred on (cx, cy) with half-width rx and
 * half-height ry, shaped by `shape`. Starts at the right and runs clockwise
 * on screen.
 */
export function eggPoints(cx: number, cy: number, rx: number, ry: number, shape: EggShape, count: number): Pt[] {
  const taper = shape.taper ?? 0;
  const e = 2 / Math.max(1, shape.squareness ?? 2);
  const lift = clamp(shape.lift ?? 0, -0.9, 0.9);
  const co = Math.cos(shape.rotation ?? 0);
  const si = Math.sin(shape.rotation ?? 0);
  const n = Math.max(8, Math.round(count));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ey = Math.sign(s) * Math.abs(s) ** e;
    const ex = Math.sign(c) * Math.abs(c) ** e;
    // Only the half being narrowed changes, so the full width stays at the widest point.
    const k = taper >= 0 ? 1 - taper * Math.max(0, -ey) : 1 + taper * Math.max(0, ey);
    const x = rx * ex * k;
    // The top half is 1 - lift of ry tall and the bottom half 1 + lift, so the widest point sits lift * ry above centre.
    const y = ry * ey * (ey < 0 ? 1 - lift : 1 + lift) - ry * lift;
    pts.push([cx + x * co - y * si, cy + x * si + y * co]);
  }
  return pts;
}

/**
 * Pushes each point along its normal by smooth noise: a hand-drawn wobble.
 * `amount` is the largest push in pixels. `knots` sets how many bumps go
 * round the whole outline.
 */
export function wobble(pts: readonly Pt[], rng: Rng, amount: number, knots: number): Pt[] {
  if (!(amount > 0) || pts.length < 3) return [...pts];
  const loop = periodicNoise(rng, knots);
  const n = pts.length;
  return offsetPoly(pts, outwardNormals(pts), (i) => amount * loop(i / n));
}

/**
 * Smooth noise that repeats every 1 unit of u, so a closed outline has no
 * seam: a few sine waves with whole-number frequencies near `knots` plus
 * finer ones near 3 * knots. Values stay within [-1, 1].
 */
export function periodicNoise(rng: Rng, knots: number): (u: number) => number {
  const k = Math.max(1, knots);
  const waves: [number, number, number][] = [];
  for (let i = 0; i < 3; i++) waves.push([0.6, Math.max(1, Math.round(k * rng.range(0.5, 1.5))), rng.range(0, TAU)]);
  for (let i = 0; i < 3; i++) waves.push([0.25, Math.max(2, Math.round(3 * k * rng.range(0.6, 1.4))), rng.range(0, TAU)]);
  const total = waves.reduce((sum, w) => sum + w[0], 0);
  return (u) => {
    let v = 0;
    for (const [a, f, p] of waves) v += a * Math.sin(TAU * f * u + p);
    return v / total;
  };
}

/* ------------------------------------------------------------------ brush (stroked marks) */

interface StrokeBucket {
  color: string;
  alpha: number;
  width: number;
  comp: GlobalCompositeOperation;
  /** Flat op list: 0 x y = moveTo, 1 x y = lineTo, 2 cx cy x y = quadraticCurveTo. */
  ops: number[];
}

const WIDTH_STEP = Math.log(1.14);
const MIN_WIDTH = 0.35;
const ALPHA_STEPS = 24;

function inView(v: Bounds, minX: number, minY: number, maxX: number, maxY: number, pad: number): boolean {
  return maxX + pad >= v.minX && minX - pad <= v.maxX && maxY + pad >= v.minY && minY - pad <= v.maxY;
}

/**
 * Collects stroked marks into buckets keyed by colour, alpha (steps of 1/24),
 * width (steps of 14 percent) and blend mode, then strokes each bucket as one
 * path. Marks wholly outside `view` are dropped. Buckets paint in the order
 * they were first used.
 *
 * With `stableOrder`, a dropped mark still claims its bucket's place in that
 * order, so which marks fall outside `view` never changes the order the
 * visible ones paint in. A shape that moves across the stage then paints the
 * same pixels wherever it is.
 */
export class Brush {
  private buckets = new Map<string, StrokeBucket>();

  private readonly view: Bounds;
  private readonly stableOrder: boolean;

  constructor(view: Bounds, stableOrder = false) {
    this.view = view;
    this.stableOrder = stableOrder;
  }

  private bucket(color: string, alpha: number, width: number, comp: GlobalCompositeOperation): StrokeBucket | null {
    const a = Math.round(Math.min(1, alpha) * ALPHA_STEPS) / ALPHA_STEPS;
    if (!(a > 0) || !(width >= MIN_WIDTH) || !paintable(color)) return null;
    const k = Math.round(Math.log(width / MIN_WIDTH) / WIDTH_STEP);
    const w = Math.round(MIN_WIDTH * Math.exp(k * WIDTH_STEP) * 100) / 100;
    const key = `${color}|${a}|${w}|${comp}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { color, alpha: a, width: w, comp, ops: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** One quadratic curve from (x0, y0) through the pull of (cx, cy) to (x1, y1). */
  quad(
    color: string, alpha: number, width: number, comp: GlobalCompositeOperation,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  ): void {
    const minX = Math.min(x0, cx, x1);
    const minY = Math.min(y0, cy, y1);
    const claimed = this.stableOrder ? this.bucket(color, alpha, width, comp) : null;
    if (!inView(this.view, minX, minY, Math.max(x0, cx, x1), Math.max(y0, cy, y1), width)) return;
    (claimed ?? this.bucket(color, alpha, width, comp))?.ops.push(0, x0, y0, 2, cx, cy, x1, y1);
  }

  /** An open polyline given as flat [x0, y0, x1, y1, ...]. */
  line(color: string, alpha: number, width: number, comp: GlobalCompositeOperation, pts: readonly number[]): void {
    if (pts.length < 4) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    const claimed = this.stableOrder ? this.bucket(color, alpha, width, comp) : null;
    if (!inView(this.view, minX, minY, maxX, maxY, width)) return;
    const b = claimed ?? this.bucket(color, alpha, width, comp);
    if (!b) return;
    b.ops.push(0, pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) b.ops.push(1, pts[i], pts[i + 1]);
  }

  /** Strokes every bucket, then empties the brush. Leaves alpha at 1 and the blend mode at source-over. */
  flush(ctx: Ctx2D): void {
    // Only a stableOrder brush can hold empty buckets (claimed by marks outside the view).
    const used = [...this.buckets.values()].filter((b) => b.ops.length > 0);
    this.buckets.clear();
    if (used.length === 0) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of used) {
      ctx.globalCompositeOperation = b.comp;
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.beginPath();
      const ops = b.ops;
      let i = 0;
      while (i < ops.length) {
        if (ops[i] === 0) {
          ctx.moveTo(ops[i + 1], ops[i + 2]);
          i += 3;
        } else if (ops[i] === 1) {
          ctx.lineTo(ops[i + 1], ops[i + 2]);
          i += 3;
        } else {
          ctx.quadraticCurveTo(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4]);
          i += 5;
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

export interface DryStroke {
  /** Quadratic centreline: start, control, end. */
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  /** Full brush width across all bristles. */
  width: number;
  bristles: number;
  color: string;
  alpha: number;
  /** 0 is a loaded brush with solid bristles. 1 is a dry brush whose bristles break up and run out early. */
  gaps: number;
  comp?: GlobalCompositeOperation;
}

/**
 * One dry-brush stroke: a quadratic path split into parallel bristles. Each
 * bristle has its own width, alpha and a slight splay at the tail, and gaps
 * that grow toward the end of the stroke as the paint runs out.
 */
export function dryStroke(brush: Brush, rng: Rng, s: DryStroke): void {
  const n = Math.max(1, Math.round(s.bristles));
  const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
  if (!(len > 0.01)) return;
  const nx = -(s.y1 - s.y0) / len;
  const ny = (s.x1 - s.x0) / len;
  const bw = s.width / n;
  const comp = s.comp ?? 'source-over';
  for (let i = 0; i < n; i++) {
    const o = n === 1 ? 0 : (i / (n - 1) - 0.5) * s.width * 0.9 + rng.range(-0.35, 0.35) * bw;
    const w = bw * rng.range(0.7, 1.6);
    const a = s.alpha * rng.range(0.5, 1);
    const splay = rng.range(-0.6, 0.6) * bw;
    const ax = s.x0 + nx * o;
    const ay = s.y0 + ny * o;
    const bx = s.cx + nx * (o + splay * 0.4);
    const by = s.cy + ny * (o + splay * 0.4);
    const cx = s.x1 + nx * (o + splay);
    const cy = s.y1 + ny * (o + splay);
    let t = rng.range(0, 0.1);
    const tEnd = 1 - rng.range(0, 0.12) - s.gaps * rng.range(0, 0.3);
    for (let guard = 0; t < tEnd && guard < 7; guard++) {
      const e = Math.min(tEnd, t + rng.range(0.18, 0.75) * (1 - 0.55 * s.gaps * t));
      // The piece [t, e] of the quadratic: ends on the curve, control point by blossoming.
      const u = 1 - t;
      const v = 1 - e;
      brush.quad(
        s.color, a, w, comp,
        u * u * ax + 2 * u * t * bx + t * t * cx, u * u * ay + 2 * u * t * by + t * t * cy,
        u * v * ax + (u * e + t * v) * bx + t * e * cx, u * v * ay + (u * e + t * v) * by + t * e * cy,
        v * v * ax + 2 * v * e * bx + e * e * cx, v * v * ay + 2 * v * e * by + e * e * cy,
      );
      t = e + s.gaps * rng.range(0.015, 0.14) * (0.4 + t);
    }
  }
}

/**
 * Ragged paint edge: broken runs of the outline between indices `from` and
 * `to`, stroked centred on the outline at three widths in the paint colour.
 * Every run stays attached to the paint, so the edge wanders in and out
 * instead of showing detached slivers. `reach` is how far the widest runs
 * poke past the outline, `gaps` (0 to 1) how broken the runs are.
 */
export function ragEdge(
  brush: Brush, rng: Rng, pts: readonly Pt[], from: number, to: number, reach: number, gaps: number, color: string,
): void {
  if (!(reach > 0.2)) return;
  const last = Math.min(to, pts.length - 1);
  const passes: [number, number][] = [
    [0.55, 0.05],
    [1, 0.25 + 0.4 * gaps],
    [1.4, 0.5 + 0.45 * gaps],
  ];
  for (const [scale, drop] of passes) {
    let run: number[] = [];
    let width = 2 * reach * scale * rng.range(0.75, 1.25);
    let on = rng.next() > drop;
    for (let i = Math.max(0, from); i <= last; i++) {
      if (on) {
        run.push(pts[i][0], pts[i][1]);
        if (rng.next() < drop * 0.35) {
          brush.line(color, 1, width, 'source-over', run);
          run = [];
          on = false;
        }
      } else if (rng.next() < 0.4) {
        on = true;
        width = 2 * reach * scale * rng.range(0.75, 1.25);
        run.push(pts[i][0], pts[i][1]);
      }
    }
    brush.line(color, 1, width, 'source-over', run);
  }
}

/**
 * Hairline flicks where the brush left the edge: short strokes that start
 * just inside the outline and exit at a shallow angle. `pick` chooses the
 * outline index for each flick (return -1 to skip).
 */
export function edgeFlicks(
  brush: Brush, rng: Rng, pts: readonly Pt[], normals: readonly Pt[], count: number,
  pick: (r: Rng) => number, opts: { length: number; reach: number; width: number; color: string; gaps: number },
): void {
  for (let k = 0; k < count; k++) {
    const j = pick(rng);
    if (j < 0 || j >= pts.length) continue;
    const [px, py] = pts[j];
    const [nx, ny] = normals[j];
    const dir = rng.next() < 0.5 ? 1 : -1;
    const tx = -ny * dir;
    const ty = nx * dir;
    const len = opts.length * rng.range(0.4, 1.4);
    const exit = opts.reach * rng.range(0.5, 2.2);
    const inset = rng.range(1, 3 + opts.reach);
    const x0 = px - nx * inset;
    const y0 = py - ny * inset;
    dryStroke(brush, rng, {
      x0, y0,
      cx: x0 + tx * len * 0.6, cy: y0 + ty * len * 0.6,
      x1: x0 + tx * len + nx * exit, y1: y0 + ty * len + ny * exit,
      width: opts.width * rng.range(0.7, 1.6), bristles: rng.next() < 0.6 ? 1 : 2,
      color: opts.color, alpha: 1, gaps: opts.gaps,
    });
  }
}

/**
 * Loose scribble of short arcs inside an ellipse, like a patch rubbed in with
 * a small round brush. `wander` (0 to 1) is how far each arc's centre strays
 * from the middle: low values swirl round the centre, high values tangle.
 */
export function scribble(
  brush: Brush, rng: Rng, cx: number, cy: number, rx: number, ry: number, count: number,
  color: string, alpha: number, width: number, wander = 0.62,
): void {
  if (!(rx > 0.5 && ry > 0.5) || !(alpha > 0)) return;
  const steps = 8;
  for (let i = 0; i < Math.round(count); i++) {
    const d = clamp(wander, 0, 1) * Math.sqrt(rng.next());
    const at = rng.range(0, TAU);
    const k = (1 - d) * rng.range(0.4, 0.95);
    const ox = cx + Math.cos(at) * rx * d;
    const oy = cy + Math.sin(at) * ry * d;
    const a0 = rng.range(0, TAU);
    const sweep = rng.range(0.8, 2.3) * (rng.next() < 0.5 ? 1 : -1);
    const squash = rng.range(0.7, 1.3);
    const pts: number[] = [];
    for (let j = 0; j <= steps; j++) {
      const a = a0 + (sweep * j) / steps;
      pts.push(ox + Math.cos(a) * rx * k, oy + Math.sin(a) * ry * k * squash);
    }
    brush.line(color, alpha * rng.range(0.5, 1), width * rng.range(0.7, 1.3), 'source-over', pts);
  }
}

/* ------------------------------------------------------------------ marks (filled shapes) */

interface FillBucket {
  color: string;
  alpha: number;
  comp: GlobalCompositeOperation;
  shapes: number[][];
}

/**
 * Collects filled marks (spindles, ribbons, polygons) into buckets keyed by
 * colour, alpha and blend mode, then fills each bucket as one path. Every
 * shape is stored with the same winding, so overlapping marks never punch
 * holes in each other under the nonzero rule. `stableOrder` works as on Brush.
 */
export class Marks {
  private buckets = new Map<string, FillBucket>();

  private readonly view: Bounds;
  private readonly stableOrder: boolean;

  constructor(view: Bounds, stableOrder = false) {
    this.view = view;
    this.stableOrder = stableOrder;
  }

  private bucket(color: string, a: number, comp: GlobalCompositeOperation): FillBucket {
    const key = `${color}|${a}|${comp}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { color, alpha: a, comp, shapes: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Adds a closed shape given as flat [x0, y0, x1, y1, ...]. */
  shape(color: string, alpha: number, flat: number[], comp: GlobalCompositeOperation = 'source-over'): void {
    if (flat.length < 6 || !paintable(color)) return;
    const a = Math.round(Math.min(1, alpha) * ALPHA_STEPS) / ALPHA_STEPS;
    if (!(a > 0)) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let area = 0;
    const n = flat.length;
    for (let i = 0; i < n; i += 2) {
      minX = Math.min(minX, flat[i]);
      maxX = Math.max(maxX, flat[i]);
      minY = Math.min(minY, flat[i + 1]);
      maxY = Math.max(maxY, flat[i + 1]);
      const j = (i + 2) % n;
      area += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
    }
    const claimed = this.stableOrder ? this.bucket(color, a, comp) : null;
    if (!inView(this.view, minX, minY, maxX, maxY, 1)) return;
    const pts = area > 0 ? flat : reverseFlat(flat);
    (claimed ?? this.bucket(color, a, comp)).shapes.push(pts);
  }

  /**
   * A spindle: a thin mark along a quadratic from (x0, y0) through the pull
   * of (cx, cy) to (x1, y1), pointed at both ends and widest at `peak`
   * (0 to 1 along it). Scratches, flecks and nose highlights.
   */
  spindle(
    color: string, alpha: number,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, width: number, peak = 0.4,
    comp: GlobalCompositeOperation = 'source-over',
  ): void {
    if (!(width > 0.05)) return;
    const pk = clamp(peak, 0.1, 0.9);
    const steps = 6;
    const half: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const s = u < pk ? u / pk : (1 - u) / (1 - pk);
      half.push((width / 2) * Math.sqrt(Math.max(0, s)));
    }
    this.shape(color, alpha, ribbonOutline(quadPoints(x0, y0, cx, cy, x1, y1, steps), half), comp);
  }

  /**
   * A brush line of varying width along a polyline (flat x, y pairs), with
   * `widths` giving the full width at each point. Rounded ends are added when
   * an end is wider than a hairline.
   */
  ribbon(color: string, alpha: number, pts: readonly number[], widths: readonly number[], comp: GlobalCompositeOperation = 'source-over'): void {
    if (pts.length < 4) return;
    this.shape(color, alpha, ribbonOutline(pts, widths.map((w) => w / 2), true), comp);
  }

  /** Fills every bucket, then empties. Leaves alpha at 1 and the blend mode at source-over. */
  flush(ctx: Ctx2D): void {
    const used = [...this.buckets.values()].filter((b) => b.shapes.length > 0);
    this.buckets.clear();
    if (used.length === 0) return;
    for (const b of used) {
      ctx.globalCompositeOperation = b.comp;
      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      for (const s of b.shapes) {
        ctx.moveTo(s[0], s[1]);
        for (let i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function reverseFlat(flat: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

/** Points along a quadratic curve, as flat x, y pairs. */
export function quadPoints(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    out.push(a * x0 + b * cx + c * x1, a * y0 + b * cy + c * y1);
  }
  return out;
}

/** Closed outline of a strip of half-width half[i] along a polyline. Optional round caps. */
function ribbonOutline(pts: readonly number[], half: readonly number[], caps = false): number[] {
  const n = pts.length >> 1;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = pts[2 * b] - pts[2 * a];
    let ty = pts[2 * b + 1] - pts[2 * a + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const h = half[Math.min(i, half.length - 1)];
    left.push(pts[2 * i] - ty * h, pts[2 * i + 1] + tx * h);
    right.push(pts[2 * i] + ty * h, pts[2 * i + 1] - tx * h);
  }
  const out = [...left];
  if (caps) roundCap(out, pts, n - 1, n - 2, half[Math.min(n - 1, half.length - 1)]);
  for (let i = n - 1; i >= 0; i--) out.push(right[2 * i], right[2 * i + 1]);
  if (caps) roundCap(out, pts, 0, 1, half[0]);
  return out;
}

/**
 * Half-circle cap of radius h at point i of a polyline, bulging away from
 * point j. It runs from the side the outline arrives on to the other side.
 */
function roundCap(out: number[], pts: readonly number[], i: number, j: number, h: number): void {
  if (!(h > 0.4) || j < 0 || j >= pts.length >> 1) return;
  let ox = pts[2 * i] - pts[2 * j];
  let oy = pts[2 * i + 1] - pts[2 * j + 1];
  const l = Math.hypot(ox, oy) || 1;
  ox /= l;
  oy /= l;
  const x = pts[2 * i];
  const y = pts[2 * i + 1];
  // (-oy, ox) is the side the outline arrives on at both ends; the cap sweeps through the outward direction o.
  for (let k = 1; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push(x + (-oy * c + ox * s) * h, y + (ox * c + oy * s) * h);
  }
}

/* ------------------------------------------------------------------ washes */

/** An outline prepared for washes: points, outward normals, arc length and optional per-point softness. */
export interface WashShape {
  pts: Pt[];
  normals: Pt[];
  s: number[];
  soft?: number[];
}

/**
 * Prepares a closed outline for wash() and brokenRim(). `soft` scales how far
 * the wash edge wanders at each point: 0 keeps a hard edge there, 1 is the
 * normal soft edge, and larger values spread further.
 */
export function washShape(pts: readonly Pt[], soft?: (x: number, y: number) => number): WashShape {
  const clean = signedArea(pts) > 0 ? [...pts] : [...pts].reverse();
  const s: number[] = [0];
  for (let i = 1; i < clean.length; i++) s.push(s[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
  return {
    pts: clean,
    normals: outwardNormals(clean),
    s,
    soft: soft ? clean.map(([x, y]) => Math.max(0, soft(x, y))) : undefined,
  };
}

/** Low-frequency edge wander: a mean push plus three sine waves along the arc length. */
function wander(rng: Rng, bias: number, scale: number): (s: number) => number {
  const waves: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) waves.push([rng.range(0.25, 0.7), TAU / (scale * rng.range(0.3, 2)), rng.range(0, TAU)]);
  const base = bias + gauss(rng) * 0.45;
  return (s) => {
    let v = base;
    for (const [a, f, p] of waves) v += a * Math.sin(s * f + p);
    return v;
  };
}

export interface WashOptions {
  color: string;
  /** Number of translucent copies. */
  layers: number;
  /** Alpha of each copy. `layers` copies at alpha a cover 1 - (1 - a)^layers at the core. */
  alpha: number;
  /** How far each copy's edge wanders, px. This sets the width of the soft edge. */
  spread: number;
  /** Mean edge offset in units of spread. Negative keeps the wash inside the outline. */
  bias?: number;
  /** Per-point jitter of each copy, px, for a ragged rather than smooth soft edge. */
  jitter?: number;
  /** Arc length of the slowest wander wave, px. Defaults to 300. */
  waveLength?: number;
  composite?: GlobalCompositeOperation;
}

/**
 * Soft layered fill: many translucent copies of each shape, each with its
 * edge pushed in and out by a different slow wander. The core sees every
 * copy and reaches full strength; the edge sees only some, so it softens
 * unevenly, like a brushed-out shadow. All shapes share each layer's fill.
 */
export function wash(ctx: Ctx2D, shapes: readonly WashShape[], rng: Rng, o: WashOptions): void {
  if (!paintable(o.color) || o.layers < 1 || !(o.alpha > 0) || shapes.length === 0) return;
  const jitter = o.jitter ?? o.spread * 0.2;
  const bias = o.bias ?? 0;
  const scale = o.waveLength ?? 300;
  ctx.globalCompositeOperation = o.composite ?? 'source-over';
  ctx.globalAlpha = Math.min(1, o.alpha);
  ctx.fillStyle = o.color;
  for (let k = 0; k < Math.round(o.layers); k++) {
    ctx.beginPath();
    for (const sh of shapes) {
      const w = wander(rng, bias, scale);
      for (let i = 0; i < sh.pts.length; i++) {
        const soft = sh.soft ? sh.soft[i] : 1;
        const off = soft * (o.spread * w(sh.s[i]) + gauss(rng) * jitter);
        const x = sh.pts[i][0] + sh.normals[i][0] * off;
        const y = sh.pts[i][1] + sh.normals[i][1] * off;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export interface RimOptions {
  color: string;
  alpha: number;
  /** Line width, px. */
  width: number;
  /** How far inside the outline the line sits, px. */
  inset: number;
  /** Chance that a stretch of outline gets no line, 0 to 1. */
  gaps: number;
  /** Passes laid over each other, each with its own gaps. */
  passes: number;
  /** Only points where this returns true get a line. */
  where?: (x: number, y: number) => boolean;
  composite?: GlobalCompositeOperation;
}

/**
 * A thin darker line that comes and goes just inside an outline, like paint
 * that gathered at the edge of a stroke. Multiplies by default, so a darker
 * tint of the body colour deepens whatever is under it.
 */
export function brokenRim(ctx: Ctx2D, shape: WashShape, rng: Rng, o: RimOptions): void {
  if (!paintable(o.color) || !(o.alpha > 0) || !(o.width > 0) || o.passes < 1) return;
  const n = shape.pts.length;
  ctx.globalCompositeOperation = o.composite ?? 'multiply';
  ctx.globalAlpha = Math.min(1, o.alpha);
  ctx.strokeStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 0; k < Math.round(o.passes); k++) {
    ctx.beginPath();
    const w = wander(rng, 0, 200);
    let drawing = false;
    let runLeft = 0;
    let open = false;
    for (let i = 0; i <= n; i++) {
      const v = i % n;
      const [px, py] = shape.pts[v];
      if (o.where && !o.where(px, py)) {
        open = false;
        runLeft = 0;
        continue;
      }
      const off = -o.inset + 0.35 * o.inset * w(shape.s[v]);
      const x = px + shape.normals[v][0] * off;
      const y = py + shape.normals[v][1] * off;
      if (runLeft <= 0) {
        drawing = rng.next() > o.gaps;
        runLeft = 4 + rng.int(0, 30);
        open = false;
      }
      runLeft--;
      if (!drawing) continue;
      if (!open) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      open = true;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
