// PROTOTYPE pastel mark-making for the pastel study: filled grounds, waxy contour bands, hatching, loop tangles and sgraffito blades.
import type { Ctx2D, Rng } from '../../../engine/types';
import { TAU } from '../../parts/math';
import { crayon, isNone, type Batch, type Paper } from './crayon';
import { toLocal, toScene, type Frame, type Outline, type Pt } from './geom';

/** Fills a closed scene-space polygon. Coordinates are rounded to 0.1 px to keep draw logs small. */
export function fillPolygon(ctx: Ctx2D, pts: readonly number[], color: string): void {
  if (pts.length < 6 || isNone(color)) return;
  ctx.fillStyle = color;
  tracePolygon(ctx, pts);
  ctx.fill();
}

export function tracePolygon(ctx: Ctx2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(Math.round(pts[0] * 10) / 10, Math.round(pts[1] * 10) / 10);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(Math.round(pts[i] * 10) / 10, Math.round(pts[i + 1] * 10) / 10);
  ctx.closePath();
}

/** Moves every outline point inward (negative: outward) along its normal. */
export function inset(o: Outline, by: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < o.pts.length; i += 2) out.push(o.pts[i] - o.normals[i] * by, o.pts[i + 1] - o.normals[i + 1] * by);
  return out;
}

export interface BandOptions {
  /** Depth inside the outline where the pastel reaches full cover, px. */
  band: number;
  /** How far past the outline stray flecks reach, px. */
  outer: number;
  /** Coats of strokes laid over the band. */
  coats: number;
  /** Pressure at the inner side of the band and at the outline itself. */
  inner: number;
  edge: number;
  lenMin: number;
  lenMax: number;
  /** Lanes per stroke, see StrokeOptions.lanes. */
  lanes?: number;
}

/**
 * Waxy edge: short strokes that follow the outline, laid at random depths
 * across a band. Pressure falls toward the outline, so the paper tooth breaks
 * the colour into flecks there and the ground shows through.
 */
export function contourBand(sticks: readonly Batch[], o: Outline, opts: BandOptions, paper: Paper, rng: Rng): void {
  const n = o.pts.length >> 1;
  if (n < 3 || sticks.length === 0) return;
  const visible: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = o.pts[2 * i];
    const y = o.pts[2 * i + 1];
    if (x >= paper.x0 && x <= paper.x1 && y >= paper.y0 && y <= paper.y1) visible.push(i);
  }
  if (visible.length === 0) return;
  const width = sticks[0].width * (1 + 0.85 * ((opts.lanes ?? 1) - 1));
  const avgLen = (opts.lenMin + opts.lenMax) / 2;
  const count = Math.min(6000, Math.round((opts.coats * visible.length * o.spacing * (opts.band + opts.outer)) / Math.max(1, width * avgLen)));
  const pressureAt = (d: number) => {
    if (d >= 0) {
      const t = opts.band > 0 ? Math.min(1, d / opts.band) : 1;
      return opts.edge + (opts.inner - opts.edge) * t * t * (3 - 2 * t);
    }
    const t = opts.outer > 0 ? Math.min(1, -d / opts.outer) : 1;
    return opts.edge * (1 - 0.7 * t);
  };
  const pts: number[] = [];
  const press: number[] = [];
  for (let s = 0; s < count; s++) {
    const start = visible[rng.int(0, visible.length)];
    const len = rng.range(opts.lenMin, opts.lenMax);
    const steps = Math.max(2, Math.round(len / 7));
    const stride = len / steps / o.spacing;
    const d0 = rng.range(-opts.outer, opts.band);
    const d1 = Math.min(opts.band, Math.max(-opts.outer, d0 + rng.range(-0.3, 0.3) * (opts.band + opts.outer)));
    const dir = rng.next() < 0.5 ? 1 : -1;
    pts.length = 0;
    press.length = 0;
    for (let j = 0; j <= steps; j++) {
      const fi = start + dir * j * stride;
      const i0 = ((Math.floor(fi) % n) + n) % n;
      const i1 = (i0 + 1) % n;
      const f = fi - Math.floor(fi);
      const x = o.pts[2 * i0] + (o.pts[2 * i1] - o.pts[2 * i0]) * f;
      const y = o.pts[2 * i0 + 1] + (o.pts[2 * i1 + 1] - o.pts[2 * i0 + 1]) * f;
      const nx = o.normals[2 * i0];
      const ny = o.normals[2 * i0 + 1];
      const d = d0 + (d1 - d0) * (j / steps);
      pts.push(x - nx * d, y - ny * d);
      press.push(pressureAt(d));
    }
    crayon(sticks[rng.int(0, sticks.length)], pts, press, paper, { ramp: 0.15, lanes: opts.lanes });
  }
}

export interface HatchOptions {
  /** Stroke direction in the frame, radians; 0 runs down the frame's y axis. */
  angle: number;
  /** Distance between neighbouring strokes, px. */
  spacing: number;
  segMin: number;
  segMax: number;
  /** Random turn of each stroke, radians. */
  wander: number;
  ramp?: number;
  /** Lanes per stroke, see StrokeOptions.lanes. */
  lanes?: number;
}

/**
 * Hatches a local box of a frame with parallel strokes. `field` gives the
 * pressure at a local point (0 outside the region), so shading fades out
 * through the paper tooth instead of along a hard edge.
 */
export function hatch(
  sticks: readonly Batch[],
  f: Frame,
  box: { x0: number; y0: number; x1: number; y1: number },
  field: (lx: number, ly: number) => number,
  opts: HatchOptions,
  paper: Paper,
  rng: Rng,
): void {
  if (sticks.length === 0 || !(opts.spacing > 0)) return;
  const dx = Math.sin(opts.angle);
  const dy = Math.cos(opts.angle);
  const qx = dy;
  const qy = -dx;
  const corners: Pt[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ];
  let qMin = Infinity;
  let qMax = -Infinity;
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const [x, y] of corners) {
    const q = x * qx + y * qy;
    const d = x * dx + y * dy;
    qMin = Math.min(qMin, q);
    qMax = Math.max(qMax, q);
    dMin = Math.min(dMin, d);
    dMax = Math.max(dMax, d);
  }
  const lines = Math.min(4000, Math.ceil((qMax - qMin) / opts.spacing));
  const scenField = (x: number, y: number) => {
    const [lx, ly] = toLocal(f, x, y);
    return field(lx, ly);
  };
  for (let li = 0; li <= lines; li++) {
    const q = qMin + li * opts.spacing + rng.range(-0.4, 0.4) * opts.spacing;
    let t = dMin - rng.range(0, opts.segMax);
    let guard = 0;
    while (t < dMax && guard++ < 400) {
      const len = rng.range(opts.segMin, opts.segMax);
      const a = rng.range(-opts.wander, opts.wander);
      const ex = dx + qx * a;
      const ey = dy + qy * a;
      const sx = q * qx + t * dx;
      const sy = q * qy + t * dy;
      const mx = sx + ex * len * 0.5;
      const my = sy + ey * len * 0.5;
      const bx = sx + ex * len;
      const by = sy + ey * len;
      t += len * rng.range(0.75, 1.05);
      if (field(sx, sy) <= 0 && field(mx, my) <= 0 && field(bx, by) <= 0) continue;
      const bow = rng.range(-0.6, 0.6);
      const [x0, y0] = toScene(f, sx, sy);
      const [x1, y1] = toScene(f, mx + qx * bow, my + qy * bow);
      const [x2, y2] = toScene(f, bx, by);
      if (Math.max(x0, x2) < paper.x0 || Math.min(x0, x2) > paper.x1 || Math.max(y0, y2) < paper.y0 || Math.min(y0, y2) > paper.y1) continue;
      crayon(sticks[rng.int(0, sticks.length)], [x0, y0, x1, y1, x2, y2], 1, paper, {
        ramp: opts.ramp ?? 0.25,
        field: scenField,
        lanes: opts.lanes,
      });
    }
  }
}

/**
 * A tangle of small overlapping loops inside an ellipse of radii (rx, ry)
 * around the frame origin, as when a patch is worked in with the tip of the
 * stick. `falloff` scales pressure by the distance from the centre (0 to 1).
 */
export function tangle(
  sticks: readonly Batch[],
  f: Frame,
  rx: number,
  ry: number,
  loops: number,
  falloff: (edge: number) => number,
  paper: Paper,
  rng: Rng,
): void {
  const r = Math.min(rx, ry);
  if (!(r > 1) || sticks.length === 0) return;
  const sx = rx / r;
  const sy = ry / r;
  const pts: number[] = [];
  for (let i = 0; i < loops; i++) {
    const rr = r * rng.range(0.18, 0.5);
    const d = Math.sqrt(rng.next()) * Math.max(0, r - rr * 0.8);
    const a = rng.range(0, TAU);
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    const span = rng.range(2, 5);
    const a0 = rng.range(0, TAU);
    const squash = rng.range(0.55, 1);
    const turn = rng.range(0, Math.PI);
    const ct = Math.cos(turn);
    const st = Math.sin(turn);
    const steps = Math.max(6, Math.min(60, Math.ceil((span * rr) / 5)));
    pts.length = 0;
    for (let j = 0; j <= steps; j++) {
      const t = a0 + (span * j) / steps;
      const ux = Math.cos(t) * rr;
      const uy = Math.sin(t) * rr * squash;
      pts.push(...toScene(f, (cx + ux * ct - uy * st) * sx, (cy + ux * st + uy * ct) * sy));
    }
    crayon(sticks[rng.int(0, sticks.length)], pts, rng.range(0.65, 1) * falloff(d / r), paper, { ramp: 0.25, lanes: 2 });
  }
}

const q1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Sgraffito blade: a thin mark along a gentle quadratic curve from (x0, y0)
 * through the pull of (cx, cy) to (x1, y1), sharp at both ends and widest at
 * `peak` (0 to 1 along it), like a line scratched back through the wax. Adds
 * one closed shape to a fill batch (Palette.blades). Scene pixels.
 */
export function blade(batch: Batch, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, width: number, peak = 0.4): void {
  if (!(width > 0.05)) return;
  const n = 7;
  const pk = Math.min(0.9, Math.max(0.1, peak));
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    const x = a * x0 + b * cx + c * x1;
    const y = a * y0 + b * cy + c * y1;
    const tx = 2 * (1 - u) * (cx - x0) + 2 * u * (x1 - cx);
    const ty = 2 * (1 - u) * (cy - y0) + 2 * u * (y1 - cy);
    const len = Math.hypot(tx, ty) || 1;
    const s = u < pk ? u / pk : (1 - u) / (1 - pk);
    const hw = (width / 2) * Math.sqrt(Math.max(0, s));
    left.push(q1(x - (ty / len) * hw), q1(y + (tx / len) * hw));
    right.push(q1(x + (ty / len) * hw), q1(y - (tx / len) * hw));
  }
  const run = left;
  for (let i = right.length - 2; i >= 0; i -= 2) run.push(right[i], right[i + 1]);
  batch.runs.push(run);
}
