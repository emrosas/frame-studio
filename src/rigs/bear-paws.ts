/**
 * The bear's paws: two stubby limbs in the body's gouache paint. Each limb is
 * a capsule from a shoulder inside the body to a round paw, painted like the
 * body (opaque fill, ragged bristle edge and flicks, a washed shade down one
 * side, tonal streaks and a few scratches),
 * with a soft shade under it and a thin darker rim where it sits over the
 * body, since paw and body share a colour. Little toe strokes mark the paw.
 *
 * The pose sets where each limb starts and ends, in the body frame:
 * - idle: both paws low on the body front
 * - wave: one paw raised beside the face, swinging back and forth on t
 * - cheer: both paws up above the head corners, out past the ears
 * - shy: both paws over the muzzle and cheeks, below the eyes
 *
 * Limb marks are laid out along the limb, so a waving paw keeps its paint as
 * it swings.
 */
import type { Ctx2D, Rng } from '../engine/types';
import { waveCycle } from './bear-motion';
import { clamp, degToRad } from './parts/math';
import {
  Brush, Marks, brokenRim, dryStroke, edgeFlicks, fillPoly, mixColor, outwardNormals, ragEdge, resample, tracePoly, wash, washShape,
  wobble, EVERYWHERE, type Pt,
} from './parts/paint';
import type { ParamReader } from './parts/params';

export const BEAR_POSES = ['idle', 'wave', 'cheer', 'shy'] as const;
export type BearPose = (typeof BEAR_POSES)[number];

/** What the paws need to know about the body they sit on. Body frame: origin at the top centre of the head, y down. */
export interface PawBody {
  W: number;
  /** Approximate distance inside the body at a body-frame point: positive inside. */
  depth(x: number, y: number): number;
  /** The body's opaque outline, which the paw shade is clipped to. */
  solid: readonly Pt[];
  /** Local x of the left and right body edges at depth y. */
  sides(y: number): [number, number];
}

/** One limb in the body frame: shoulder (ax, ay) to paw centre, as an angle and a length. */
interface Limb {
  side: number;
  ax: number;
  ay: number;
  angle: number;
  length: number;
}

/** How far a waving paw swings either side of its rest angle. */
const WAVE_SWING = degToRad(16);

/** The nose and muzzle centres in the body frame, plus the muzzle half size, all in pixels. */
function facePlace(p: ParamReader, W: number) {
  const fx = p.number('faceX') * W;
  const fy = p.number('faceY') * W;
  const a = degToRad(p.number('faceTilt'));
  const mx = p.number('muzzleX') * W;
  const my = p.number('muzzleY') * W;
  return {
    fx, fy,
    mcx: fx + mx * Math.cos(a) - my * Math.sin(a),
    mcy: fy + mx * Math.sin(a) + my * Math.cos(a),
    mw: (p.number('muzzleWidth') * W) / 2,
    mh: (p.number('muzzleHeight') * W) / 2,
  };
}

function limb(side: number, ax: number, ay: number, px: number, py: number, swing = 0): Limb {
  return { side, ax, ay, angle: Math.atan2(py - ay, px - ax) + swing, length: Math.max(1, Math.hypot(px - ax, py - ay)) };
}

/** Where the two limbs go for the pose, at time t. */
function layout(body: PawBody, p: ParamReader, t: number, rng: Rng): Limb[] {
  const { W } = body;
  const f = facePlace(p, W);
  const low = Math.max(f.mcy + f.mh, f.fy + W * 0.3);
  const edge = (side: number, y: number) => body.sides(y)[side < 0 ? 0 : 1];
  const idle = (side: number) => limb(side, side * W * 0.36, low + W * 0.02, side * W * 0.2, low + W * 0.2);
  const pose = p.string('pose') as BearPose;
  const waver = p.string('wavePaw') === 'left' ? -1 : 1;
  switch (pose) {
    case 'wave': {
      const ay = f.fy + W * 0.4;
      const swing = WAVE_SWING * waveCycle(rng.fork('wave'), p.number('waveSpeed'), t) * waver;
      const raised = limb(waver, edge(waver, ay) - waver * W * 0.14, ay, edge(waver, f.fy) + waver * W * 0.2, f.fy - W * 0.06, swing);
      return [-1, 1].map((side) => (side === waver ? raised : idle(side)));
    }
    case 'cheer':
      // Up and out past the ears, so the arms cross the ears' outer edge at most.
      return [-1, 1].map((side) => {
        const key = side < 0 ? 'Left' : 'Right';
        const ear = Math.abs(p.number(`ear${key}X`)) + p.number('earSize');
        const ay = W * 0.38;
        return limb(side, edge(side, ay) - side * W * 0.15, ay, side * W * (ear + 0.2), (p.number(`ear${key}Y`) - 0.2) * W);
      });
    case 'shy':
      return [-1, 1].map((side) => {
        const ay = f.mcy + f.mh + W * 0.3;
        return limb(side, edge(side, ay) - side * W * 0.12, ay, f.mcx + side * f.mw * 0.78, f.mcy + f.mh * 0.2);
      });
    default:
      return [-1, 1].map(idle);
  }
}

/**
 * Closed outline of a limb in its own frame: shoulder at the origin, paw
 * centre at (length, 0). A fixed number of points per stretch, so the wobble
 * keeps its shape whatever the length.
 */
function limbOutline(length: number, r: number): Pt[] {
  const r0 = r * 0.82;
  const pts: Pt[] = [];
  const arc = 14;
  const run = 10;
  // Paw end, bottom (+y) round the tip to the top, a little fuller than a circle.
  for (let i = 0; i <= arc; i++) {
    const a = Math.PI / 2 - (i / arc) * Math.PI;
    pts.push([length + Math.cos(a) * r * 1.06, Math.sin(a) * r]);
  }
  // Top side back to the shoulder.
  for (let i = 1; i < run; i++) {
    const u = 1 - i / run;
    pts.push([length * u, -(r0 + (r - r0) * u)]);
  }
  // Shoulder end.
  for (let i = 0; i <= arc; i++) {
    const a = -Math.PI / 2 - (i / arc) * Math.PI;
    pts.push([Math.cos(a) * r0, Math.sin(a) * r0]);
  }
  // Bottom side out to the paw.
  for (let i = 1; i < run; i++) {
    const u = i / run;
    pts.push([length * u, r0 + (r - r0) * u]);
  }
  return pts;
}

/** Draws both paws. The context is in the body frame. */
export function drawPaws(ctx: Ctx2D, body: PawBody, p: ParamReader, rng: Rng, t: number): void {
  const { W } = body;
  const r = (p.number('pawSize') * W) / 2;
  if (r < 1) return;
  const color = p.string('body');
  const limbs = layout(body, p, t, rng);
  for (const lb of limbs) {
    const rl = rng.fork(lb.side < 0 ? 'left' : 'right');
    // Resampled after the wobble, so the ragged edge and flicks have as many points to work with as the body's edge.
    const outline = resample(wobble(limbOutline(lb.length, r), rl.fork('shape'), r * 0.05 * p.number('edgeRough'), 4), clamp(W / 60, 3, 40));
    const cos = Math.cos(lb.angle);
    const sin = Math.sin(lb.angle);
    const toBody = ([x, y]: Pt): Pt => [lb.ax + x * cos - y * sin, lb.ay + x * sin + y * cos];
    drawShade(ctx, body, p, rl.fork('shade'), outline.map(toBody));
    ctx.save();
    ctx.translate(lb.ax, lb.ay);
    ctx.rotate(lb.angle);
    drawLimb(ctx, body, p, rl, lb, outline, r, color, toBody);
    ctx.restore();
  }
}

/** A soft shade the limb throws on the body, down and to the side of it. */
function drawShade(ctx: Ctx2D, body: PawBody, p: ParamReader, rng: Rng, outline: Pt[]): void {
  const { W } = body;
  const shade = p.string('shade');
  const dx = W * 0.012;
  const dy = W * 0.03;
  const shape = washShape(outline.map(([x, y]): Pt => [x + dx, y + dy]));
  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, body.solid);
  ctx.clip();
  const layers = 3;
  wash(ctx, [shape], rng, { color: shade, layers, alpha: 1 - (1 - 0.45) ** (1 / layers), spread: W * 0.012, bias: -0.4, waveLength: W * 0.6 });
  ctx.restore();
}

function drawLimb(
  ctx: Ctx2D, body: PawBody, p: ParamReader, rng: Rng, lb: Limb, outline: Pt[], r: number, color: string,
  toBody: (q: Pt) => Pt,
): void {
  const { W } = body;
  const rough = p.number('edgeRough');
  const gaps = p.number('dryness');
  const tonal = p.number('tonal');
  const brush = new Brush(EVERYWHERE);

  // Opaque paint with a ragged bristle edge and a few flicks where the brush left it, as on the body's sides.
  fillPoly(ctx, outline, color);
  const loop = [...outline, ...outline.slice(0, 3)];
  const re = rng.fork('edge');
  const reach = rough * (1 + W * 0.006);
  ragEdge(brush, re, loop, 0, loop.length - 1, reach * 0.7, gaps * 0.8, color);
  if (rough > 0) {
    edgeFlicks(brush, re, outline, outwardNormals(outline), Math.min(120, Math.round((outline.length * rough) / 6)), (q) => q.int(0, outline.length), {
      length: r * 0.7, reach, width: Math.max(0.6, Math.sqrt(W / 400)) * 1.4, color, gaps: gaps * 0.7,
    });
  }
  brush.flush(ctx);

  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, outline);
  ctx.clip();

  // A washed shade down the side of the limb facing down and right (the side the body's shades fall on),
  // crisp at the edge and brushed out toward the middle, for roundness.
  const shade = p.string('shade');
  const span = lb.length + r;
  const away = -0.4 * Math.sin(lb.angle) + Math.cos(lb.angle) >= 0 ? 1 : -1;
  const under: Pt[] = [];
  for (let i = 0; i <= 8; i++) under.push([-r + (span + r * 0.2) * (i / 8), away * r * 1.3]);
  for (let i = 8; i >= 0; i--) under.push([-r + (span + r * 0.2) * (i / 8), away * r * 0.3]);
  // Soft toward the middle of the limb, hard at its edge (where the clip cuts it anyway).
  const band = washShape(under, (_x, y) => (Math.abs(y) < r * 0.8 ? 2.5 : 0.3));
  wash(ctx, [band], rng.fork('under'), {
    color: shade, layers: 4, alpha: 0.07, spread: r * 0.3, bias: -0.1, jitter: r * 0.05, waveLength: span * 0.7,
  });

  // Tonal and dry-brush streaks along the limb, in the body's tints, a little stronger so a pale limb still reads.
  const light = mixColor(color, '#ffffff', 0.08 + 0.22 * tonal);
  const dark = mixColor(color, shade, 0.35 + 0.5 * tonal);
  const pale = mixColor(color, p.string('scratch'), 0.7);
  const rs = rng.fork('streaks');
  const n = Math.round(clamp(8 + (span / r) * 4, 8, 32) * Math.min(2, Math.max(0.5, p.number('strokes'))));
  for (let i = 0; i < n; i++) {
    const v = rs.range(-0.85, 0.85) * r;
    const u0 = rs.range(-0.5 * r, span * 0.8);
    const len = rs.range(0.3, 0.9) * Math.max(r, span * 0.4);
    const pick = rs.next();
    dryStroke(brush, rs, {
      x0: u0, y0: v, cx: u0 + len / 2, cy: v + rs.range(-0.12, 0.12) * r, x1: u0 + len, y1: v + rs.range(-0.2, 0.2) * r,
      width: r * rs.range(0.12, 0.3), bristles: rs.int(3, 7), color: pick < 0.4 ? light : dark,
      alpha: (0.45 + 0.55 * tonal) * rs.range(0.15, 0.4), gaps,
    });
  }
  brush.flush(ctx);

  // A few thin light scratches, most of them out on the paw.
  const rk = rng.fork('scratches');
  const marks = new Marks(EVERYWHERE);
  const thin = Math.max(0.5, Math.sqrt(W / 400) * 1.1 * p.number('scratchWidth'));
  const count = Math.round(rk.range(2, 5) * Math.min(2, p.number('scratches')));
  for (let i = 0; i < count; i++) {
    const u = lb.length + rk.range(-0.9, 0.5) * r;
    const v = rk.range(-0.6, 0.6) * r;
    const len = r * rk.range(0.25, 0.6);
    const tilt = rk.range(-0.25, 0.25);
    marks.spindle(pale, 1, u, v, u + len * 0.5, v + len * tilt * 0.5 + rk.range(-1, 1) * thin, u + len, v + len * tilt, thin * rk.range(0.8, 1.5), 0.4);
  }
  marks.flush(ctx);

  // Toes: two short strokes into the paw from its tip, inside the clip so none pokes past the paw.
  const rt = rng.fork('toes');
  const toe = p.string('rimColor');
  for (const v of [-0.3, 0.3]) {
    const x0 = lb.length + r * 1.02;
    const y0 = v * r + rt.range(-0.05, 0.05) * r;
    dryStroke(brush, rt, {
      x0, y0, cx: x0 - r * 0.18, cy: y0 * 1.05, x1: x0 - r * rt.range(0.34, 0.44), y1: y0 * 0.95,
      width: Math.max(1, r * 0.09), bristles: 2, color: toe, alpha: 0.85, gaps: gaps * 0.3,
    });
  }
  brush.flush(ctx);
  ctx.restore();

  // A thin darker rim round the paw end, where it sits over the body.
  const fromShoulder = lb.length * 0.35;
  brokenRim(ctx, washShape(outline), rng.fork('rim'), {
    color: toe, alpha: 0.8, width: Math.max(0.9, W * 0.0045), inset: Math.max(1, r * 0.04), gaps: 0.2, passes: 2,
    composite: 'source-over',
    where: (x, y) => {
      if (x < fromShoulder) return false;
      const [bx, by] = toBody([x, y]);
      return body.depth(bx, by) > 2;
    },
  });
}
