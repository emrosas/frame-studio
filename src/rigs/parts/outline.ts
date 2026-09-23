import type { Ctx2D, Rng } from '../../engine/types';
import { TAU, clamp } from './math';

/**
 * A point on a closed outline. Corner points keep a sharp join when the
 * outline is traced as a smooth curve; every other point is smoothed through.
 */
export interface Point {
  x: number;
  y: number;
  corner?: boolean;
}

/** Target distance between outline samples, in the shape's local pixels. */
export const OUTLINE_SPACING = 32;

/** Points evenly spaced around a circle of the given radius, centred on the origin. */
export function sampleCircle(radius: number, spacing = OUTLINE_SPACING): Point[] {
  const count = clamp(Math.ceil((TAU * radius) / spacing), 8, 128);
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/**
 * A width x height rectangle centred on the origin, clockwise from the top
 * edge. Radius 0 gives four sharp corners; otherwise each corner is a
 * quarter arc.
 */
export function sampleRoundedRect(
  width: number,
  height: number,
  cornerRadius: number,
  spacing = OUTLINE_SPACING,
): Point[] {
  const hw = width / 2;
  const hh = height / 2;
  const r = clamp(cornerRadius, 0, Math.min(hw, hh));
  if (r <= 0) {
    return resampleLoop(
      [
        { x: -hw, y: -hh, corner: true },
        { x: hw, y: -hh, corner: true },
        { x: hw, y: hh, corner: true },
        { x: -hw, y: hh, corner: true },
      ],
      spacing,
    );
  }

  const arcs = [
    { cx: hw - r, cy: -hh + r, start: -TAU / 4 }, // top right
    { cx: hw - r, cy: hh - r, start: 0 }, // bottom right
    { cx: -hw + r, cy: hh - r, start: TAU / 4 }, // bottom left
    { cx: -hw + r, cy: -hh + r, start: TAU / 2 }, // top left
  ];
  const steps = Math.max(2, Math.ceil((r * TAU) / 4 / spacing));
  const points: Point[] = [];
  for (const arc of arcs) {
    for (let k = 0; k <= steps; k++) {
      const angle = arc.start + (k / steps) * (TAU / 4);
      points.push({ x: arc.cx + Math.cos(angle) * r, y: arc.cy + Math.sin(angle) * r });
    }
  }
  return resampleLoop(points, spacing);
}

/**
 * Subdivides every edge of a closed loop so no gap is longer than `spacing`.
 * Input points keep their corner flag; inserted points are smooth.
 * Consecutive duplicate points are dropped.
 */
export function resampleLoop(points: readonly Point[], spacing = OUTLINE_SPACING): Point[] {
  const out: Point[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    out.push(a);
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
  }
  return out;
}

/** Distance around the outline between one hand-drawn bulge and the next, in local pixels. */
export const WOBBLE_WAVELENGTH = 90;

/**
 * Displaces an outline the way a hand redrawing it would: a few slow bulges
 * in and out along the outline's normal, about `amount` pixels deep, plus a
 * little fine jitter. Every random choice comes from `rng`, so the same rng
 * gives the same drawing.
 */
export function wobbleOutline(points: readonly Point[], amount: number, rng: Rng): Point[] {
  const n = points.length;
  if (n < 3 || amount <= 0) return points.slice();

  const along: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    along.push(perimeter);
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (perimeter <= 0) return points.slice();

  const waves = Math.max(3, Math.round(perimeter / WOBBLE_WAVELENGTH));
  const bulges = Array.from({ length: waves }, () => rng.range(-1, 1));
  const bulge = (k: number): number => bulges[((k % waves) + waves) % waves]!;
  const fine = amount * 0.2;

  return points.map((point, i) => {
    const prev = points[(i - 1 + n) % n]!;
    const next = points[(i + 1) % n]!;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const length = Math.hypot(tx, ty) || 1;

    const u = (along[i]! / perimeter) * waves;
    const k = Math.floor(u);
    const push = amount * catmullRom(bulge(k - 1), bulge(k), bulge(k + 1), bulge(k + 2), u - k);

    return {
      x: point.x + (ty / length) * push + rng.range(-fine, fine),
      y: point.y - (tx / length) * push + rng.range(-fine, fine),
      corner: point.corner,
    };
  });
}

/** Smooth curve through p1 (f = 0) and p2 (f = 1), shaped by the neighbours p0 and p3. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, f: number): number {
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f)
  );
}

/**
 * Adds a closed curve through every point to the current path, as a
 * Catmull-Rom spline drawn with cubic Beziers. Corner points get zero-length
 * handles so the curve meets them in a sharp join.
 */
export function traceSmoothLoop(ctx: Ctx2D, points: readonly Point[]): void {
  const n = points.length;
  if (n < 3) return;
  const at = (i: number): Point => points[((i % n) + n) % n]!;

  ctx.moveTo(at(0).x, at(0).y);
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = p1.corner ? p1 : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = p2.corner ? p2 : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
  }
  ctx.closePath();
}
