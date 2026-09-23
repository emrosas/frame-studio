// PROTOTYPE crayon strokes for the pastel study: polylines broken up on the shared paper tooth.
import type { Ctx2D } from '../../../engine/types';
import { toothHeight } from './tooth';

/** The sheet every stroke lands on, plus the visible window strokes are culled to. */
export interface Paper {
  /** Tooth scale, 1 is the default grain. */
  scale: number;
  /** 0: strokes are solid. 1: pastel only lands where the tooth is higher than 1 - pressure. */
  strength: number;
  /** Sampling step along a stroke, in scene pixels. */
  step: number;
  /** Culling window in scene pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function makePaper(width: number, height: number, scale: number, strength: number): Paper {
  const margin = 24;
  return { scale: Math.max(0.05, scale), strength, step: 1.5, x0: -margin, y0: -margin, x1: width + margin, y1: height + margin };
}

/** One pastel stick: every run laid with it is stroked in one path, so overlaps do not double up. */
export interface Batch {
  color: string;
  width: number;
  alpha: number;
  /** Runs are closed shapes to fill (blades) instead of lines to stroke. */
  fill: boolean;
  runs: number[][];
}

/** Batches in paint order. flush() strokes them and starts over. */
export class Palette {
  private batches: Batch[] = [];

  stick(color: string, width: number, alpha = 1): Batch {
    const w = Math.round(Math.max(0.3, width) * 10) / 10;
    for (const b of this.batches) if (!b.fill && b.color === color && b.width === w && b.alpha === alpha) return b;
    const b: Batch = { color, width: w, alpha, fill: false, runs: [] };
    this.batches.push(b);
    return b;
  }

  /** A batch of filled marks (see blade in strokes.ts), painted in order with the sticks. */
  blades(color: string, alpha = 1): Batch {
    for (const b of this.batches) if (b.fill && b.color === color && b.alpha === alpha) return b;
    const b: Batch = { color, width: 0, alpha, fill: true, runs: [] };
    this.batches.push(b);
    return b;
  }

  flush(ctx: Ctx2D): void {
    for (const b of this.batches) {
      if (b.runs.length === 0 || isNone(b.color)) continue;
      ctx.globalAlpha = b.alpha;
      if (b.fill) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        for (const run of b.runs) {
          ctx.moveTo(run[0], run[1]);
          for (let i = 2; i < run.length; i += 2) ctx.lineTo(run[i], run[i + 1]);
          ctx.closePath();
        }
        ctx.fill();
        continue;
      }
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const run of b.runs) {
        ctx.moveTo(run[0], run[1]);
        for (let i = 2; i < run.length; i += 2) ctx.lineTo(run[i], run[i + 1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.batches = [];
  }
}

export function isNone(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c === 'none' || c === 'transparent';
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface StrokeOptions {
  /** Fraction of the length over which pressure builds at the start and eases off at the end. */
  ramp?: number;
  /** Extra pressure multiplier at a scene point, for soft-edged shading. */
  field?: (x: number, y: number) => number;
  /** Overrides the paper's tooth strength for this stroke (scratches bite less). */
  strength?: number;
  /**
   * Parallel lanes the stick is split into across its width, each tested
   * against the tooth on its own, so the colour breaks into specks across the
   * stroke as well as along it. The outer lanes press lighter than the middle.
   */
  lanes?: number;
}

/**
 * Lays one crayon stroke along a polyline (x, y pairs in scene pixels).
 * `press` is the peak pressure, or one pressure per vertex. Coverage breaks up
 * wherever the paper tooth is lower than 1 - pressure, so light strokes leave
 * flecks and heavy ones leave only the deepest pits.
 */
export function crayon(batch: Batch, pts: readonly number[], press: number | readonly number[], paper: Paper, opts: StrokeOptions = {}): void {
  const lanes = Math.max(1, Math.min(6, Math.round(opts.lanes ?? 1)));
  if (lanes === 1 || pts.length < 4) {
    lane(batch, pts, press, 1, paper, opts);
    return;
  }
  const n = pts.length >> 1;
  const normals: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const tx = pts[2 * b] - pts[2 * a];
    const ty = pts[2 * b + 1] - pts[2 * a + 1];
    const len = Math.hypot(tx, ty) || 1;
    normals.push(-ty / len, tx / len);
  }
  const gap = batch.width * 0.85;
  const shifted: number[] = new Array(pts.length);
  for (let j = 0; j < lanes; j++) {
    const off = (j - (lanes - 1) / 2) * gap;
    const edge = (lanes - 1) / 2 > 0 ? Math.abs(j - (lanes - 1) / 2) / ((lanes - 1) / 2) : 0;
    for (let i = 0; i < n; i++) {
      shifted[2 * i] = pts[2 * i] + normals[2 * i] * off;
      shifted[2 * i + 1] = pts[2 * i + 1] + normals[2 * i + 1] * off;
    }
    lane(batch, shifted, press, 1 - 0.3 * edge * edge, paper, opts);
  }
}

function lane(batch: Batch, pts: readonly number[], press: number | readonly number[], gain: number, paper: Paper, opts: StrokeOptions): void {
  const n = pts.length >> 1;
  if (n < 2) return;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    seg.push(l);
    total += l;
  }
  if (!(total > 0)) return;
  const step = paper.step;
  const count = Math.max(1, Math.ceil(total / step));
  const ramp = opts.ramp ?? 0.2;
  const strength = opts.strength ?? paper.strength;
  const perVertex = typeof press !== 'number';
  const field = opts.field;

  let run: number[] | null = null;
  let since = 0;
  let lastX = 0;
  let lastY = 0;
  let si = 0;
  let segStart = 0;
  const finish = (dx: number, dy: number) => {
    if (!run) return;
    if (run.length === 2) {
      // A single fleck: a short dab along the stroke.
      run.push(r1(lastX + dx * 0.6), r1(lastY + dy * 0.6));
    } else if (run[run.length - 2] !== r1(lastX) || run[run.length - 1] !== r1(lastY)) {
      run.push(r1(lastX), r1(lastY));
    }
    batch.runs.push(run);
    run = null;
  };

  let dx = 0;
  let dy = 0;
  for (let k = 0; k <= count; k++) {
    const s = (k / count) * total;
    while (si < seg.length - 1 && s > segStart + seg[si]) {
      segStart += seg[si];
      si++;
    }
    const f = seg[si] > 0 ? Math.min(1, (s - segStart) / seg[si]) : 0;
    const ax = pts[2 * si];
    const ay = pts[2 * si + 1];
    const bx = pts[2 * si + 2];
    const by = pts[2 * si + 3];
    const x = ax + (bx - ax) * f;
    const y = ay + (by - ay) * f;
    if (seg[si] > 0) {
      dx = ((bx - ax) / seg[si]) * step;
      dy = ((by - ay) / seg[si]) * step;
    }

    let on = x >= paper.x0 && x <= paper.x1 && y >= paper.y0 && y <= paper.y1;
    if (on) {
      const u = s / total;
      let p = gain * (perVertex ? press[si] + ((press[si + 1] ?? press[si]) - press[si]) * f : press);
      if (ramp > 0) {
        const e = Math.min(u, 1 - u) / ramp;
        p *= e >= 1 ? 1 : 0.45 + 0.55 * e * e * (3 - 2 * e);
      }
      if (field && p > 0.01) p *= field(x, y);
      if (p <= 0.02) on = false;
      else if (strength > 0 && p < 1) on = toothHeight(x, y, paper.scale) > strength * (1 - p);
    }

    if (on) {
      if (!run) {
        run = [r1(x), r1(y)];
        since = 0;
      } else if (++since >= 6) {
        run.push(r1(x), r1(y));
        since = 0;
      }
      lastX = x;
      lastY = y;
    } else if (run) {
      finish(dx, dy);
    }
  }
  finish(dx, dy);
}
