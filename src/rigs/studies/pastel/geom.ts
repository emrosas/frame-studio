// PROTOTYPE geometry for the pastel study: local frames, rounded bodies, eggs and edge wobble.
import type { Rng } from '../../../engine/types';
import { TAU } from '../../parts/math';

/** A rotated local frame: local (x, y) maps to scene (ox + x cos - y sin, oy + x sin + y cos). */
export interface Frame {
  ox: number;
  oy: number;
  cos: number;
  sin: number;
}

export function frame(ox: number, oy: number, angle: number): Frame {
  return { ox, oy, cos: Math.cos(angle), sin: Math.sin(angle) };
}

/** A child frame placed at local (x, y) of `parent`, turned by `angle` more. */
export function child(parent: Frame, x: number, y: number, angle: number): Frame {
  const [ox, oy] = toScene(parent, x, y);
  const a = Math.atan2(parent.sin, parent.cos) + angle;
  return frame(ox, oy, a);
}

export function toScene(f: Frame, x: number, y: number): [number, number] {
  return [f.ox + x * f.cos - y * f.sin, f.oy + x * f.sin + y * f.cos];
}

export function toLocal(f: Frame, x: number, y: number): [number, number] {
  const dx = x - f.ox;
  const dy = y - f.oy;
  return [dx * f.cos + dy * f.sin, -dx * f.sin + dy * f.cos];
}

/** Local polyline (x, y pairs) to scene coordinates. */
export function mapPts(f: Frame, local: readonly number[]): number[] {
  const out: number[] = new Array(local.length);
  for (let i = 0; i < local.length; i += 2) {
    out[i] = f.ox + local[i] * f.cos - local[i + 1] * f.sin;
    out[i + 1] = f.oy + local[i] * f.sin + local[i + 1] * f.cos;
  }
  return out;
}

export type Pt = [number, number];

/** A convex polygon with every corner rounded by r: the core polygon grown by a disc of radius r. */
export interface RoundedPoly {
  core: Pt[];
  r: number;
}

export function roundPolygon(verts: readonly Pt[], r: number): RoundedPoly {
  const n = verts.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of verts) {
    cx += x / n;
    cy += y / n;
  }
  // Each edge's line pushed inward by r; the core vertex is where neighbouring lines meet.
  const lines = verts.map((a, i) => {
    const b = verts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    let nx = -dy;
    let ny = dx;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { px: a[0] + nx * r, py: a[1] + ny * r, dx, dy };
  });
  const core: Pt[] = verts.map((_v, i) => {
    const l1 = lines[(i + n - 1) % n];
    const l2 = lines[i];
    const det = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(det) < 1e-9) return [l2.px, l2.py];
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
    return [l1.px + l1.dx * t, l1.py + l1.dy * t];
  });
  return { core, r };
}

/** Signed distance to a simple polygon, negative inside (after Inigo Quilez). */
function sdPolygon(v: readonly Pt[], px: number, py: number): number {
  let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const ex = v[j][0] - v[i][0];
    const ey = v[j][1] - v[i][1];
    const wx = px - v[i][0];
    const wy = py - v[i][1];
    const ee = ex * ex + ey * ey;
    const h = ee > 0 ? Math.min(1, Math.max(0, (wx * ex + wy * ey) / ee)) : 0;
    const bx = wx - ex * h;
    const by = wy - ey * h;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1];
    const c2 = py < v[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** Depth inside the rounded polygon at a local point: positive inside, negative outside. */
export function depth(poly: RoundedPoly, x: number, y: number): number {
  return poly.r - sdPolygon(poly.core, x, y);
}

/** A closed outline in scene pixels: points, outward unit normals, and the spacing between points. */
export interface Outline {
  pts: number[];
  normals: number[];
  spacing: number;
}

/** Samples the rounded polygon's boundary at about `step` pixels, in local coordinates. */
export function sampleRounded(poly: RoundedPoly, step: number): { pts: number[]; normals: number[] } {
  const { core, r } = poly;
  const n = core.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of core) {
    cx += x / n;
    cy += y / n;
  }
  const outward = (i: number): Pt => {
    const a = core[i];
    const b = core[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    if (nx * (a[0] - cx) + ny * (a[1] - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  };
  const pts: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = outward((i + n - 1) % n);
    const [qx, qy] = outward(i);
    const a0 = Math.atan2(py, px);
    let da = Math.atan2(qy, qx) - a0;
    while (da > Math.PI) da -= TAU;
    while (da <= -Math.PI) da += TAU;
    const arcSteps = Math.max(1, Math.ceil((Math.abs(da) * Math.max(r, 1)) / step));
    for (let k = 0; k < arcSteps; k++) {
      const a = a0 + (da * k) / arcSteps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pts.push(core[i][0] + c * r, core[i][1] + s * r);
      normals.push(c, s);
    }
    const b = core[(i + 1) % n];
    const len = Math.hypot(b[0] - core[i][0], b[1] - core[i][1]);
    const lineSteps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < lineSteps; k++) {
      const t = k / lineSteps;
      pts.push(core[i][0] + (b[0] - core[i][0]) * t + qx * r, core[i][1] + (b[1] - core[i][1]) * t + qy * r);
      normals.push(qx, qy);
    }
  }
  return { pts, normals };
}

/**
 * Egg / superellipse outline centred on the origin, local coordinates, y down.
 * taper > 0 narrows the top, taper < 0 narrows the bottom. squareness 2 is an
 * ellipse, higher is boxier.
 */
export function eggAt(rx: number, ry: number, taper: number, squareness: number, angle: number): Pt {
  const e = 2 / Math.max(1, squareness);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ex = Math.sign(c) * Math.abs(c) ** e;
  const ey = Math.sign(s) * Math.abs(s) ** e;
  // Only the half being narrowed changes, so the full width stays at the middle.
  const k = taper >= 0 ? 1 - taper * Math.max(0, -ey) : 1 + taper * Math.max(0, ey);
  return [rx * ex * k, ry * ey];
}

export function eggPoints(rx: number, ry: number, taper: number, squareness: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(...eggAt(rx, ry, taper, squareness, (i / count) * TAU));
  return out;
}

/** Outward normals of a closed polyline, from its neighbours. */
export function closedNormals(pts: readonly number[]): number[] {
  const n = pts.length >> 1;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  const sign = area >= 0 ? 1 : -1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const tx = pts[2 * b] - pts[2 * a];
    const ty = pts[2 * b + 1] - pts[2 * a + 1];
    const len = Math.hypot(tx, ty) || 1;
    out.push((ty / len) * sign, (-tx / len) * sign);
  }
  return out;
}

/** Resamples a closed polyline to even spacing of about `step`. */
export function resampleClosed(pts: readonly number[], step: number): { pts: number[]; spacing: number } {
  const n = pts.length >> 1;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum.push(cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]));
  }
  const total = cum[n];
  if (!(total > 0)) return { pts: [...pts], spacing: 1 };
  const m = Math.max(8, Math.round(total / Math.max(0.5, step)));
  const spacing = total / m;
  const out: number[] = [];
  let i = 0;
  for (let k = 0; k < m; k++) {
    const s = k * spacing;
    while (i < n - 1 && cum[i + 1] < s) i++;
    const j = (i + 1) % n;
    const f = cum[i + 1] > cum[i] ? (s - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    out.push(pts[2 * i] + (pts[2 * j] - pts[2 * i]) * f, pts[2 * i + 1] + (pts[2 * j + 1] - pts[2 * i + 1]) * f);
  }
  return { pts: out, spacing };
}

/** Smooth 1D noise in [-1, 1], periodic over `size` units, from the rng. */
export function noise1(rng: Rng, size = 256): (s: number) => number {
  const table: number[] = [];
  for (let i = 0; i < size; i++) table.push(rng.range(-1, 1));
  return (s) => {
    const f = Math.floor(s);
    const t = s - f;
    const i = ((f % size) + size) % size;
    const a = table[i];
    const b = table[(i + 1) % size];
    return a + (b - a) * t * t * (3 - 2 * t);
  };
}

/** Pushes each point of a closed local outline along its normal by a hand wobble. */
export function wobble(pts: readonly number[], normals: readonly number[], spacing: number, amount: number, rng: Rng): number[] {
  const n1 = noise1(rng.fork('low'));
  const n2 = noise1(rng.fork('mid'));
  const n3 = noise1(rng.fork('fine'));
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const s = (i >> 1) * spacing;
    const d = amount * (2.6 * n1(s / 150) + 1.3 * n2(s / 38) + 0.55 * n3(s / 7));
    out.push(pts[i] + normals[i] * d, pts[i + 1] + normals[i + 1] * d);
  }
  return out;
}

export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
