// PROTOTYPE gouache study: dry-brush bristle strokes, batched into a few stroke() calls.
import type { Ctx2D, Rng } from '../../../engine/types';

export type Pt = [number, number];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Bucket {
  color: string;
  alpha: number;
  width: number;
  comp: GlobalCompositeOperation;
  /** Flat op list: 0 x y = moveTo, 1 x y = lineTo, 2 cx cy x y = quadraticCurveTo. */
  ops: number[];
}

const WIDTH_STEP = Math.log(1.14);
const MIN_WIDTH = 0.35;

/**
 * Collects bristle marks into buckets keyed by colour, alpha, width and blend
 * mode, then paints each bucket as one path with one stroke(). A thousand
 * bristles become a few dozen canvas calls, which keeps both the browser and
 * the recording test context fast. Marks outside `view` are dropped.
 */
export class Brush {
  private buckets = new Map<string, Bucket>();

  private readonly view: Bounds;

  constructor(view: Bounds) {
    this.view = view;
  }

  private bucket(color: string, alpha: number, width: number, comp: GlobalCompositeOperation): Bucket | null {
    const a = Math.round(Math.min(1, alpha) * 24) / 24;
    if (!(a > 0) || !(width >= MIN_WIDTH)) return null;
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

  private visible(minX: number, minY: number, maxX: number, maxY: number, pad: number): boolean {
    const v = this.view;
    return maxX + pad >= v.minX && minX - pad <= v.maxX && maxY + pad >= v.minY && minY - pad <= v.maxY;
  }

  quad(
    color: string, alpha: number, width: number, comp: GlobalCompositeOperation,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  ): void {
    const minX = Math.min(x0, cx, x1);
    const maxX = Math.max(x0, cx, x1);
    const minY = Math.min(y0, cy, y1);
    const maxY = Math.max(y0, cy, y1);
    if (!this.visible(minX, minY, maxX, maxY, width)) return;
    const b = this.bucket(color, alpha, width, comp);
    if (!b) return;
    b.ops.push(0, x0, y0, 2, cx, cy, x1, y1);
  }

  /** A polyline given as flat [x0, y0, x1, y1, ...]. */
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
    if (!this.visible(minX, minY, maxX, maxY, width)) return;
    const b = this.bucket(color, alpha, width, comp);
    if (!b) return;
    b.ops.push(0, pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) b.ops.push(1, pts[i], pts[i + 1]);
  }

  /** Paints every bucket in the order it was first used, then empties the brush. */
  flush(ctx: Ctx2D): void {
    if (this.buckets.size === 0) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of this.buckets.values()) {
      ctx.globalCompositeOperation = b.comp;
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.beginPath();
      const ops = b.ops;
      let i = 0;
      while (i < ops.length) {
        const op = ops[i];
        if (op === 0) {
          ctx.moveTo(ops[i + 1], ops[i + 2]);
          i += 3;
        } else if (op === 1) {
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
    this.buckets.clear();
  }
}

export interface StrokeSpec {
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
  /** 0 = loaded brush, solid bristles. 1 = dry brush, broken bristles that run out early. */
  gaps: number;
  comp?: GlobalCompositeOperation;
}

/**
 * One dry-brush stroke: a quadratic path split into parallel bristles. Each
 * bristle has its own width, alpha, a slight splay at the tail, and gaps that
 * grow toward the end of the stroke as the paint runs out.
 */
export function dryStroke(brush: Brush, rng: Rng, s: StrokeSpec): void {
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
      const on = rng.range(0.18, 0.75) * (1 - 0.55 * s.gaps * t);
      const e = Math.min(tEnd, t + on);
      // Sub-curve [t, e] of the quadratic: endpoints on the curve, control by blossoming.
      const u = 1 - t;
      const v = 1 - e;
      const sx = u * u * ax + 2 * u * t * bx + t * t * cx;
      const sy = u * u * ay + 2 * u * t * by + t * t * cy;
      const ex = v * v * ax + 2 * v * e * bx + e * e * cx;
      const ey = v * v * ay + 2 * v * e * by + e * e * cy;
      const kx = u * v * ax + (u * e + t * v) * bx + t * e * cx;
      const ky = u * v * ay + (u * e + t * v) * by + t * e * cy;
      brush.quad(s.color, a, w, comp, sx, sy, kx, ky, ex, ey);
      t = e + s.gaps * rng.range(0.015, 0.14) * (0.4 + t);
    }
  }
}

/** Smooth 1D value noise on [0, 1] with `knots` random knots, values in [-1, 1]. */
export function noise1(rng: Rng, knots: number): (u: number) => number {
  const k = Math.max(2, Math.round(knots));
  const vals: number[] = [];
  for (let i = 0; i <= k; i++) vals.push(rng.range(-1, 1));
  return (u: number) => {
    const x = Math.max(0, Math.min(1, u)) * k;
    const i = Math.min(k - 1, Math.floor(x));
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return vals[i] + (vals[i + 1] - vals[i]) * s;
  };
}

/** Outward unit normals of a closed polygon, whichever way it winds. */
export function outwardNormals(pts: readonly Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  const sign = area > 0 ? 1 : -1;
  return pts.map((_, i) => {
    const [ax, ay] = pts[(i - 1 + pts.length) % pts.length];
    const [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    // With y down, a positive-area (clockwise on screen) loop has its outside on the left of travel.
    return [(sign * dy) / l, (-sign * dx) / l] as Pt;
  });
}

/** Moves every point along its normal by d(i). */
export function offsetPoly(pts: readonly Pt[], normals: readonly Pt[], d: (i: number) => number): Pt[] {
  return pts.map(([x, y], i) => {
    const k = d(i);
    return [x + normals[i][0] * k, y + normals[i][1] * k] as Pt;
  });
}

export function tracePoly(ctx: Ctx2D, pts: readonly Pt[]): void {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Resamples a closed polygon to points roughly `step` apart. */
export function resample(pts: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(1, Math.min(400, Math.ceil(len / Math.max(0.5, step))));
    for (let j = 0; j < k; j++) out.push([x0 + ((x1 - x0) * j) / k, y0 + ((y1 - y0) * j) / k]);
  }
  return out;
}

/**
 * Ragged contour: broken runs of a polyline stroked centred on the outline at
 * a few widths. Every run is attached to the paint mass, so the edge wanders
 * in and out instead of showing detached parallel slivers. `reach` is how far
 * the widest runs poke past the outline.
 */
export function ragStroke(
  brush: Brush, rng: Rng, pts: readonly Pt[], from: number, to: number, reach: number, gaps: number, color: string,
): void {
  if (!(reach > 0.2)) return;
  const passes: [number, number][] = [
    [0.55, 0.05],
    [1, 0.25 + 0.4 * gaps],
    [1.4, 0.5 + 0.45 * gaps],
  ];
  for (const [scale, drop] of passes) {
    let run: number[] = [];
    let width = 2 * reach * scale * rng.range(0.75, 1.25);
    let on = rng.next() > drop;
    for (let i = from; i <= to; i++) {
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
