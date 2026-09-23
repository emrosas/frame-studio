// PROTOTYPE gouache study: a tombstone bear painted as opaque fills plus dry-brush bristle strokes.
import type { Ctx2D, ParamSchema, Rig, Rng } from '../../../engine/types';
import { readParams } from '../../parts/params';
import {
  Brush, dryStroke, ragStroke, noise1, offsetPoly, outwardNormals, resample, tracePoly, type Bounds, type Pt,
} from './brush';
import { mix } from './color';

const n = (def: number, min: number, max: number, description: string) =>
  ({ type: 'number', default: def, min, max, description }) as const;
const c = (def: string, description: string) => ({ type: 'color', default: def, description }) as const;

/** Face and ear params are fractions of `width`, measured in the bear's own frame (origin at the top centre, y down). */
const params: ParamSchema = {
  x: n(540, -4000, 8000, 'Scene x of the top centre of the head.'),
  y: n(760, -4000, 8000, 'Scene y of the top edge of the head. The body runs from here off the bottom of the stage.'),
  width: n(440, 40, 3000, 'Head width in scene pixels, where the rounded top meets the sides. Everything else scales with it.'),
  tilt: n(-5, -45, 45, 'Tilt of the whole bear in degrees, clockwise, about the top centre of the head.'),
  flareLeft: n(0.2, 0, 0.8, 'How fast the left side widens going down, in pixels out per pixel down.'),
  flareRight: n(0.12, 0, 0.8, 'How fast the right side widens going down, in pixels out per pixel down.'),
  corner: n(0.2, 0.02, 0.5, 'Radius of the two rounded top corners, as a fraction of width.'),
  dome: n(0.03, -0.1, 0.2, 'How much the top edge bulges up in the middle, as a fraction of width.'),

  earSize: n(0.105, 0, 0.3, 'Ear radius, as a fraction of width.'),
  earSpread: n(0.49, 0, 0.8, 'Distance from the centre line to each ear centre, as a fraction of width.'),
  earShift: n(-0.03, -0.3, 0.3, 'Moves both ears sideways, as a fraction of width. Negative is left.'),
  earY: n(-0.03, -0.4, 0.4, 'Ear centre height relative to the top edge, as a fraction of width. Negative is up.'),
  innerEarAlpha: n(0.35, 0, 1, 'Strength of the scribbled inner-ear patch, 0 to 1.'),

  faceX: n(-0.03, -0.4, 0.4, 'Sideways offset of the face (eyes, nose, muzzle, mouth), as a fraction of width.'),
  eyeY: n(0.22, 0, 0.6, 'Eye height below the top edge, as a fraction of width.'),
  eyeSpacing: n(0.2, 0, 0.45, 'Distance from the face centre to each eye, as a fraction of width.'),
  eyeSize: n(0.023, 0.005, 0.08, 'Pupil radius, as a fraction of width.'),
  eyeWhite: n(1.7, 0, 3, 'Eye-white radius as a multiple of the pupil radius. Below about 1.05 the eye is a plain dot.'),
  lookX: n(0.6, -1, 1, 'Where the pupils look sideways inside the eye whites, -1 left to 1 right.'),
  lookY: n(0, -1, 1, 'Where the pupils look vertically inside the eye whites, -1 up to 1 down.'),
  browLift: n(0.075, 0, 0.25, 'Height of the brow dashes above the eyes, as a fraction of width.'),
  browLength: n(0.09, 0, 0.25, 'Length of each brow dash, as a fraction of width.'),
  browAngle: n(12, -45, 45, 'Brow slant in degrees. Positive raises the inner ends for a curious, worried look.'),

  noseY: n(0.34, 0.1, 0.8, 'Nose centre below the top edge, as a fraction of width.'),
  noseWidth: n(0.31, 0.02, 0.7, 'Nose width, as a fraction of width.'),
  noseHeight: n(0.215, 0.02, 0.5, 'Nose height, as a fraction of width.'),
  glint: n(1, 0, 1, 'Size of the white highlight on the nose, 0 to 1.'),

  muzzleY: n(0.54, 0.1, 1, 'Muzzle centre below the top edge, as a fraction of width.'),
  muzzleWidth: n(0.38, 0, 0.9, 'Muzzle width, as a fraction of width.'),
  muzzleHeight: n(0.45, 0, 1, 'Muzzle height, as a fraction of width.'),

  mouthDrop: n(0.17, 0, 0.5, 'Length of the line from the bottom of the nose to the smile, as a fraction of width.'),
  mouthSkew: n(0.01, -0.2, 0.2, 'Sideways lean of the mouth line at the smile, as a fraction of width.'),
  smileWidth: n(0.19, 0, 0.5, 'Width of the smile, as a fraction of width.'),
  smileDepth: n(0.042, -0.1, 0.15, 'How far the smile dips below its ends, as a fraction of width. Negative frowns.'),
  lineWeight: n(0.011, 0.002, 0.04, 'Thickness of the mouth and brow lines, as a fraction of width.'),

  bridge: n(0.5, 0, 1, 'Strength of the darker patch down the nose bridge and under the chin, 0 to 1.'),
  bridgeWidth: n(0.18, 0, 0.6, 'Width of the nose-bridge band at the brow, as a fraction of width.'),
  bridgeTop: n(0.11, -0.2, 0.4, 'How far above the eye line the nose-bridge band starts, as a fraction of width.'),
  chinX: n(0.03, -0.3, 0.3, 'Sideways offset of the chin shadow under the muzzle, as a fraction of width.'),
  patchX: n(0, -0.8, 0.8, 'Chest shading patch centre x, as a fraction of width.'),
  patchY: n(1.1, 0, 2.5, 'Chest shading patch centre y below the top edge, as a fraction of width.'),
  patchSize: n(0, 0, 0.4, 'Chest shading patch radius, as a fraction of width. 0 hides it.'),
  patchAlpha: n(0.5, 0, 1, 'Chest shading patch strength, 0 to 1.'),
  castLeft: n(0, 0, 1, 'Strength of the soft shadow this bear casts on whatever is left of it, 0 to 1.'),
  castRight: n(0, 0, 1, 'Strength of the soft shadow this bear casts on whatever is right of it, 0 to 1.'),
  castWidth: n(0.3, 0, 0.8, 'Widest reach of the cast shadow, as a fraction of width. It widens going down.'),

  body: c('#f14922', 'Body paint colour.'),
  muzzle: c('#fbfaf6', 'Muzzle paint colour.'),
  innerEar: c('#f86a44', 'Inner-ear scribble colour.'),
  shade: c('#d8391a', 'Shade colour for the nose bridge, chin and chest patch, and the darker dry-brush tint.'),
  streak: c('#ff9a78', 'Colour of the thin light dry-brush scratches.'),
  nose: c('#0d0b0c', 'Nose, pupil and line colour.'),
  cast: c('#8f9cd0', 'Cast shadow colour. It multiplies, so light blue-greys darken any colour underneath.'),

  strokeDensity: n(1, 0, 3, 'Density of the tonal and dry-brush strokes on the body. 0 leaves flat paint.'),
  scratches: n(1, 0, 3, 'Density of thin light scratches on the body.'),
  edgeRough: n(1, 0, 3, 'Raggedness of paint edges: how far bristles drag past the outline and how much they break.'),
  bristleGaps: n(0.6, 0, 1, 'Dryness of the brush, 0 to 1. Higher gives more broken bristles and gaps.'),
  tonal: n(0.6, 0, 1, 'How far the lighter and darker stroke tints stray from the body colour, 0 to 1.'),
  lightSide: n(0, -1, 1, 'Which side collects more edge strokes and scratches, -1 left to 1 right.'),
};

const DEG = Math.PI / 180;
const EYE_WHITE = '#fdfcf7';
const HIGHLIGHT = '#fbfbf8';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Reader = ReturnType<typeof readParams>;

interface Frame {
  W: number;
  view: Bounds;
  /** Local y where the body leaves the stage (plus margin). */
  L: number;
  /** Local y where the stage starts (clamped at 0). */
  sMin: number;
  fL: number;
  fR: number;
  r: number;
}

export const gouacheBear: Rig = {
  id: 'gouache-bear',
  description:
    'PROTOTYPE gouache bear: a tall tombstone body with a rounded top that runs off the bottom of the stage, round ears, ' +
    'dot eyes with brow dashes, a pale muzzle, a glossy nose and a line mouth. Painted as opaque base fills, then ' +
    'batched dry-brush bristle strokes (lighter and darker tints following the body, denser near the edges), ragged ' +
    'bristle edges, stroke-built shading patches and an optional multiply shadow cast on the bears behind.',
  params,
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const W = p.number('width');
    const x0 = p.number('x');
    const y0 = p.number('y');
    const tilt = p.number('tilt') * DEG;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);

    // Stage corners in the bear's frame, for culling and for how far the body must run.
    const corners: Pt[] = [
      [0, 0], [stage.width, 0], [0, stage.height], [stage.width, stage.height],
    ].map(([sx, sy]) => {
      const dx = sx - x0;
      const dy = sy - y0;
      return [dx * cos + dy * sin, -dx * sin + dy * cos] as Pt;
    });
    const view: Bounds = {
      minX: Math.min(...corners.map((q) => q[0])),
      maxX: Math.max(...corners.map((q) => q[0])),
      minY: Math.min(...corners.map((q) => q[1])),
      maxY: Math.max(...corners.map((q) => q[1])),
    };
    const L = Math.max(W * 0.6, Math.min(view.maxY + W * 0.08 + 12, view.maxY + 4 * W));
    const f: Frame = {
      W, view, L,
      sMin: Math.max(0, Math.min(L, view.minY - W * 0.1)),
      fL: p.number('flareLeft'),
      fR: p.number('flareRight'),
      r: p.number('corner') * W,
    };

    ctx.save();
    ctx.translate(x0, y0);
    ctx.rotate(tilt);

    const outline = bodyOutline(f, p, rng.fork('outline'));
    const normals = outwardNormals(outline);

    drawCast(ctx, f, p, rng.fork('cast'), outline, normals);
    drawEars(ctx, f, p, rng.fork('ears'));
    drawBody(ctx, f, p, rng.fork('body'), outline, normals);
    drawEarSeams(ctx, f, p, outline);
    drawFace(ctx, f, p, rng.fork('face'));

    ctx.restore();
  },
};

/* ------------------------------------------------------------------ body */

function bodyOutline(f: Frame, p: Reader, rng: Rng): Pt[] {
  const { W, L, fL, fR } = f;
  const hw = W / 2;
  const r = Math.min(f.r, hw * 0.95, L * 0.5);
  const dome = p.number('dome') * W;
  const topY = (x: number) => -dome * (1 - Math.min(1, (x / hw) ** 2));
  const raw: Pt[] = [];
  raw.push([-hw - fL * L, L]);
  raw.push([-hw - fL * r, r]);
  const quadTo = (ax: number, ay: number, cx: number, cy: number, bx: number, by: number, k: number) => {
    for (let i = 1; i <= k; i++) {
      const t = i / k;
      const u = 1 - t;
      raw.push([u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by]);
    }
  };
  quadTo(-hw - fL * r, r, -hw, 0, -hw + r, topY(-hw + r), 10);
  const topSteps = 16;
  for (let i = 1; i < topSteps; i++) {
    const x = lerp(-hw + r, hw - r, i / topSteps);
    raw.push([x, topY(x)]);
  }
  raw.push([hw - r, topY(hw - r)]);
  quadTo(hw - r, topY(hw - r), hw, 0, hw + fR * r, r, 10);
  raw.push([hw + fR * L, L]);

  const step = Math.max(3, Math.min(40, W / 55));
  const pts = resample(raw, step);
  const normals = outwardNormals(pts);
  const wobble = noise1(rng, Math.max(4, Math.min(80, pts.length / 12)));
  const amp = p.number('edgeRough') * W * 0.0035;
  return offsetPoly(pts, normals, (i) => (pts[i][1] >= L - 1 ? 0 : wobble(i / pts.length) * amp));
}

/** Local x of the left and right body edges at depth s. */
function edges(f: Frame, s: number): [number, number] {
  return [-f.W / 2 - f.fL * s, f.W / 2 + f.fR * s];
}

/** Visible body area in units of 100 x 100 scene pixels, capped so extreme params stay cheap. */
function areaUnits(f: Frame): number {
  const span = Math.max(0, f.L - f.sMin);
  const [l0, r0] = edges(f, f.sMin);
  const [l1, r1] = edges(f, f.L);
  const viewW = f.view.maxX - f.view.minX;
  const avgW = Math.min(viewW, (r0 - l0 + r1 - l1) / 2);
  const stageArea = viewW * (f.view.maxY - f.view.minY);
  return Math.min(span * avgW, stageArea) / 10000;
}

/** Picks a spot across the body, biased toward an edge with probability `edgeBias`. */
function pickU(rng: Rng, edgeBias: number, lightSide: number): number {
  if (rng.next() < edgeBias) {
    const d = rng.next() ** 1.8 * 0.22;
    return rng.next() < 0.5 - 0.4 * lightSide ? d : 1 - d;
  }
  return rng.next();
}

function drawBody(ctx: Ctx2D, f: Frame, p: Reader, rng: Rng, outline: Pt[], normals: Pt[]): void {
  const { W } = f;
  const body = p.string('body');
  const shade = p.string('shade');
  const rough = p.number('edgeRough');
  const gaps = p.number('bristleGaps');
  const tonal = p.number('tonal');
  const lightSide = p.number('lightSide');
  const brush = new Brush(f.view);

  // Opaque base fill, then a dragged bristle contour.
  ctx.fillStyle = body;
  ctx.beginPath();
  tracePoly(ctx, outline);
  ctx.fill();
  paintEdgeBand(brush, rng.fork('edge'), f, outline, normals, body, rough, gaps);
  brush.flush(ctx);

  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, outline);
  ctx.clip();

  const units = areaUnits(f);
  const density = p.number('strokeDensity');
  const light = mix(body, '#ffffff', 0.08 + 0.22 * tonal);
  const dark = mix(body, shade, 0.2 + 0.5 * tonal);
  const streak = p.string('streak');

  // A: broad tonal strokes, long and faint, following the body direction.
  const ra = rng.fork('tonal');
  const nA = Math.min(700, Math.round(density * units * 0.7));
  for (let i = 0; i < nA; i++) {
    bodyStroke(brush, ra, f, ra.next(), ra.range(f.sMin, f.L), {
      len: W * ra.range(0.25, 0.8),
      width: W * ra.range(0.035, 0.09),
      bristles: ra.int(6, 10),
      color: ra.next() < 0.5 ? light : dark,
      alpha: tonal * ra.range(0.08, 0.2),
      gaps: gaps * 0.7,
    });
  }
  brush.flush(ctx);

  // B: dry-brush streaks, weighted toward the edges.
  const rb = rng.fork('streaks');
  const nB = Math.min(2200, Math.round(density * units * 2.2));
  for (let i = 0; i < nB; i++) {
    const u = pickU(rb, 0.6, lightSide);
    const edgeness = 1 - Math.min(u, 1 - u) * 2;
    const pick = rb.next();
    bodyStroke(brush, rb, f, u, rb.range(f.sMin, f.L), {
      len: W * rb.range(0.06, 0.3),
      width: W * rb.range(0.012, 0.035),
      bristles: rb.int(4, 9),
      color: pick < 0.45 ? light : pick < 0.9 ? dark : streak,
      alpha: (0.3 + 0.7 * tonal) * rb.range(0.12, 0.4) * (0.6 + 0.4 * edgeness),
      gaps,
    });
  }
  brush.flush(ctx);

  paintBridge(ctx, brush, f, p, rng.fork('bridge'));

  // C: thin light scratches in loose clusters, more toward the lower body.
  const rc = rng.fork('scratches');
  const nC = Math.min(900, Math.round(p.number('scratches') * units * 0.8));
  const thin = Math.max(0.8, Math.sqrt(W / 400));
  for (let i = 0; i < nC; i++) {
    const u0 = pickU(rc, 0.45, lightSide);
    const s0 = f.sMin + (f.L - f.sMin) * rc.next() ** 0.75;
    const k = rc.int(2, 8);
    const slant = rc.range(-0.35, 0.2);
    for (let j = 0; j < k; j++) {
      const u = u0 + rc.range(-0.07, 0.07);
      bodyStroke(brush, rc, f, Math.max(0.035, Math.min(0.965, u)), s0 + rc.range(-0.12, 0.12) * W, {
        len: W * (0.008 + 0.12 * rc.next() ** 1.7),
        width: thin * rc.range(1, 2.6),
        bristles: rc.next() < 0.75 ? 1 : 2,
        color: streak,
        alpha: rc.range(0.45, 1),
        gaps: gaps * 0.6,
        slant: slant + rc.range(-0.08, 0.08),
        bend: 0.02,
      });
    }
  }
  brush.flush(ctx);

  // Chest patch: a scribbled shade on the body (the white bear's shadow patch).
  const patchR = p.number('patchSize') * W;
  if (patchR > 0.5 && p.number('patchAlpha') > 0) {
    const px = p.number('patchX') * W;
    const py = p.number('patchY') * W;
    const a = p.number('patchAlpha');
    const rp = rng.fork('patch');
    ctx.globalAlpha = a * 0.35;
    ctx.fillStyle = shade;
    ctx.beginPath();
    tracePoly(ctx, blob(rp, px, py, patchR * 0.85, patchR * 1.25, 0.18));
    ctx.fill();
    ctx.globalAlpha = 1;
    scribble(brush, rp, px, py, patchR * 1.1, 22, shade, a * 0.45, W * 0.01);
    for (let i = 0; i < 14; i++) {
      const sx = px + rp.range(-0.8, 0.8) * patchR;
      const sy = py + rp.range(-1.1, 1.1) * patchR;
      dryStroke(brush, rp, {
        x0: sx, y0: sy - patchR * 0.35, cx: sx + rp.range(-3, 3), cy: sy, x1: sx + rp.range(-4, 4), y1: sy + patchR * 0.35,
        width: W * rp.range(0.01, 0.025), bristles: 3, color: shade, alpha: a * rp.range(0.2, 0.45), gaps,
      });
    }
    brush.flush(ctx);
  }

  ctx.restore();
}

/**
 * Nose bridge and chin shadow: a band from the brow down to the nose, joined
 * to a patch that hangs below the muzzle. Painted as a translucent flat plus
 * short strokes. Call with the body clip active.
 */
function paintBridge(ctx: Ctx2D, brush: Brush, f: Frame, p: Reader, rng: Rng): void {
  const bridge = p.number('bridge');
  if (bridge <= 0) return;
  const { W } = f;
  const fx = p.number('faceX') * W;
  const shade = p.string('shade');
  const body = p.string('body');
  const gaps = p.number('bristleGaps');
  const noseY = p.number('noseY') * W;
  const nw = (p.number('noseWidth') * W) / 2;
  const my = p.number('muzzleY') * W;
  const mw = (p.number('muzzleWidth') * W) / 2;
  const mh = (p.number('muzzleHeight') * W) / 2;
  const top = (p.number('eyeY') - p.number('bridgeTop')) * W;
  const bandW = Math.max(0.5, (p.number('bridgeWidth') * W) / 2);
  // A rounded wedge: narrow at the brow, widening toward the nose.
  const capR = bandW * 0.7;
  const baseW = Math.max(bandW * 1.15, nw * 0.7);
  const band: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    band.push([fx + Math.cos(a) * capR, top + capR + Math.sin(a) * capR]);
  }
  band.push([fx + baseW, noseY], [fx - baseW, noseY]);
  const chin = blob(rng, fx + p.number('chinX') * W, my + mh * 0.45, mw * 1.04, mh * 0.72 + W * 0.05, 0.06);
  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, band);
  tracePoly(ctx, chin);
  ctx.globalAlpha = Math.min(1, bridge * 0.9);
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.clip();
  const x0 = fx - mw * 1.2 - W * 0.02;
  const x1 = fx + mw * 1.2 + W * 0.02;
  const nStrokes = Math.min(200, Math.round(30 + ((x1 - x0) * (my + mh - top)) / (W * W * 0.004)));
  for (let i = 0; i < nStrokes; i++) {
    const x = rng.range(x0, x1);
    const y = rng.range(top, my + mh + W * 0.06);
    const len = W * rng.range(0.06, 0.2);
    const lean = rng.range(-0.15, 0.15) * len;
    dryStroke(brush, rng, {
      x0: x - lean / 2, y0: y - len / 2, cx: x + rng.range(-0.05, 0.05) * len, cy: y, x1: x + lean / 2, y1: y + len / 2,
      width: W * rng.range(0.015, 0.04), bristles: rng.int(2, 5),
      color: rng.next() < 0.6 ? shade : body, alpha: bridge * rng.range(0.08, 0.22), gaps,
    });
  }
  brush.flush(ctx);
  ctx.restore();
}

interface BodyStrokeSpec {
  len: number;
  width: number;
  bristles: number;
  color: string;
  alpha: number;
  gaps: number;
  /** Extra lean from the body direction, in radians-ish (added to dx per dy). */
  slant?: number;
  /** Curvature as a fraction of the length. */
  bend?: number;
}

/** A dry stroke centred at (u across, s down) running along the local body direction. */
function bodyStroke(brush: Brush, rng: Rng, f: Frame, u: number, s: number, o: BodyStrokeSpec): void {
  const [l, r] = edges(f, s);
  const x = lerp(l, r, u);
  const dx = lerp(-f.fL, f.fR, u) + (o.slant ?? rng.range(-0.08, 0.08));
  const dl = Math.hypot(dx, 1);
  const ux = dx / dl;
  const uy = 1 / dl;
  const h = o.len / 2;
  const bend = rng.range(-1, 1) * (o.bend ?? 0.07) * o.len;
  const up = rng.next() < 0.5;
  const sx = up ? x + ux * h : x - ux * h;
  const sy = up ? s + uy * h : s - uy * h;
  const ex = up ? x - ux * h : x + ux * h;
  const ey = up ? s - uy * h : s + uy * h;
  dryStroke(brush, rng, {
    x0: sx, y0: sy, cx: x - uy * bend, cy: s + ux * bend, x1: ex, y1: ey,
    width: o.width, bristles: o.bristles, color: o.color, alpha: o.alpha, gaps: o.gaps,
  });
}

/** Bristle band along the body outline (not the bottom edge), in chunks like separate brush drags. */
function paintEdgeBand(
  brush: Brush, rng: Rng, f: Frame, pts: Pt[], normals: Pt[], color: string, rough: number, gaps: number,
): void {
  if (rough <= 0) return;
  const count = pts.length;
  const step = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) || 1;
  const reach = rough * (1 + f.W * 0.006);
  // Outer bristles dragged along the outline: solid paint stays inside, only the contour breaks up.
  let i = 1;
  while (i < count - 2) {
    const len = Math.max(3, Math.round((f.W * rng.range(0.12, 0.4)) / step));
    const from = Math.max(1, i - 2);
    const to = Math.min(count - 2, i + len);
    const mid = Math.floor((from + to) / 2);
    const side = pts[mid][1] >= f.r * 1.1;
    ragStroke(brush, rng, pts, from, to, reach * (side ? 0.85 : 0.3) * rng.range(0.6, 1.3), gaps, color);
    i = to;
  }
  // Flicks: hairline strokes that start inside the paint and leave the edge at a shallow angle.
  const nFlicks = Math.min(400, Math.round((count * rough) / 5));
  for (let k = 0; k < nFlicks; k++) {
    const j = rng.int(1, count - 1);
    const [px, py] = pts[j];
    if (py < f.view.minY - f.W * 0.2 || py > f.view.maxY + f.W * 0.2) continue;
    const [nx, ny] = normals[j];
    const dir = rng.next() < 0.5 ? 1 : -1;
    const tx = -ny * dir;
    const ty = nx * dir;
    const len = f.W * rng.range(0.03, 0.11);
    const exit = reach * rng.range(0.5, 2.2);
    const x0 = px - nx * rng.range(1, 3 + reach);
    const y0 = py - ny * rng.range(1, 3 + reach);
    dryStroke(brush, rng, {
      x0, y0,
      cx: x0 + tx * len * 0.6, cy: y0 + ty * len * 0.6,
      x1: x0 + tx * len + nx * exit, y1: y0 + ty * len + ny * exit,
      width: rng.range(1, 2.4) * Math.max(0.6, Math.sqrt(f.W / 400)), bristles: rng.next() < 0.6 ? 1 : 2,
      color, alpha: 1, gaps: gaps * 0.7,
    });
  }
}

/* ------------------------------------------------------------------ cast shadow */

function drawCast(ctx: Ctx2D, f: Frame, p: Reader, rng: Rng, pts: Pt[], normals: Pt[]): void {
  const left = p.number('castLeft');
  const right = p.number('castRight');
  const reach = p.number('castWidth') * f.W;
  if ((left <= 0 && right <= 0) || reach <= 0) return;
  const color = p.string('cast');
  const brush = new Brush(f.view);
  const wob = noise1(rng.fork('wobble'), 24);
  const widthAt = (y: number, i: number) => reach * Math.min(1, 0.22 + y / (1.4 * f.W)) * (1 + 0.18 * wob(i / pts.length));
  for (const side of [-1, 1]) {
    const strength = side < 0 ? left : right;
    if (strength <= 0) continue;
    // Side points below the top corner, top to bottom.
    const idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (y >= f.r * 0.5 && Math.sign(x) === side && y < f.L - 1) idx.push(i);
    }
    if (idx.length < 2) continue;
    if (side < 0) idx.reverse();
    const outer: Pt[] = idx.map((i) => {
      const w = widthAt(pts[i][1], i);
      return [pts[i][0] + normals[i][0] * w, pts[i][1] + normals[i][1] * w];
    });
    const inner: Pt[] = idx.map((i) => [pts[i][0] - normals[i][0] * 6, pts[i][1] - normals[i][1] * 6] as Pt).reverse();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = color;
    // Two stacked translucent fills: a wide soft one and a narrower core.
    ctx.globalAlpha = strength * 0.4;
    ctx.beginPath();
    tracePoly(ctx, [...outer, ...inner]);
    ctx.fill();
    const core: Pt[] = idx.map((i) => {
      const w = widthAt(pts[i][1], i) * 0.45;
      return [pts[i][0] + normals[i][0] * w, pts[i][1] + normals[i][1] * w];
    });
    ctx.globalAlpha = strength * 0.3;
    ctx.beginPath();
    tracePoly(ctx, [...core, ...inner]);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Dry strokes along the edge so the shadow reads as painted.
    const rs = rng.fork(side < 0 ? 'left' : 'right');
    const nS = Math.min(220, Math.round(idx.length * 0.6));
    for (let k = 0; k < nS; k++) {
      const j = rs.int(0, idx.length);
      const i = idx[j];
      const w = widthAt(pts[i][1], i);
      const d = w * rs.range(0.1, 1.05);
      const x = pts[i][0] + normals[i][0] * d;
      const y = pts[i][1] + normals[i][1] * d;
      const tx = -normals[i][1];
      const ty = normals[i][0];
      const len = f.W * rs.range(0.05, 0.2);
      dryStroke(brush, rs, {
        x0: x - tx * len / 2, y0: y - ty * len / 2, cx: x, cy: y, x1: x + tx * len / 2, y1: y + ty * len / 2,
        width: f.W * rs.range(0.01, 0.03), bristles: rs.int(2, 5), color, alpha: strength * rs.range(0.15, 0.4), gaps: 0.7,
        comp: 'multiply',
      });
    }
  }
  brush.flush(ctx);
}

/* ------------------------------------------------------------------ ears */

function earCentres(f: Frame, p: Reader): { x: number; y: number; side: number }[] {
  const spread = p.number('earSpread') * f.W;
  const shift = p.number('earShift') * f.W;
  const y = p.number('earY') * f.W;
  return [-1, 1].map((side) => ({ x: side * spread + shift, y, side }));
}

function drawEars(ctx: Ctx2D, f: Frame, p: Reader, rng: Rng): void {
  const R = p.number('earSize') * f.W;
  if (R < 0.5) return;
  const body = p.string('body');
  const inner = p.string('innerEar');
  const innerA = p.number('innerEarAlpha');
  const rough = p.number('edgeRough');
  const gaps = p.number('bristleGaps');
  const brush = new Brush(f.view);
  for (const ear of earCentres(f, p)) {
    const re = rng.fork(ear.side < 0 ? 'left' : 'right');
    const rim = blob(re, ear.x, ear.y, R, R, 0.03 * rough);
    const reach = rough * (0.6 + f.W * 0.003);
    ctx.fillStyle = body;
    ctx.beginPath();
    tracePoly(ctx, rim);
    ctx.fill();
    if (rough > 0) {
      const loop = [...rim, ...rim.slice(0, 4)];
      ragStroke(brush, re, loop, 0, loop.length - 1, reach, gaps * 0.8, body);
      brush.flush(ctx);
    }
    // A thin darker rim line round the lower, outer part of the ear.
    ctx.strokeStyle = mix(body, p.string('shade'), 0.6);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(0.8, f.W * 0.004);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const a0 = ear.side < 0 ? Math.PI * 0.45 : Math.PI * 0.05;
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (i / 12) * Math.PI * 0.55;
      const rr = R * (0.9 + 0.03 * Math.sin(i * 1.7));
      if (i === 0) ctx.moveTo(ear.x + Math.cos(a) * rr, ear.y + Math.sin(a) * rr);
      else ctx.lineTo(ear.x + Math.cos(a) * rr, ear.y + Math.sin(a) * rr);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (innerA > 0) {
      ctx.save();
      ctx.beginPath();
      tracePoly(ctx, rim);
      ctx.clip();
      const ix = ear.x + ear.side * R * 0.06;
      const iy = ear.y - R * 0.04;
      const ir = R * 0.7;
      ctx.globalAlpha = innerA * 0.5;
      ctx.fillStyle = inner;
      ctx.beginPath();
      tracePoly(ctx, blob(re, ix, iy, ir * 0.85, ir * 0.85, 0.12));
      ctx.fill();
      ctx.globalAlpha = 1;
      scribble(brush, re, ix, iy, ir, 26, inner, innerA, Math.max(1, R * 0.08));
      scribble(brush, re, ix, iy, ir * 0.7, 6, mix(inner, '#ffffff', 0.5), innerA * 0.6, Math.max(1, R * 0.05));
      brush.flush(ctx);
      ctx.restore();
    }
  }
}

/** A faint seam where the head outline passes in front of each ear. */
function drawEarSeams(ctx: Ctx2D, f: Frame, p: Reader, outline: Pt[]): void {
  const R = p.number('earSize') * f.W;
  if (R < 0.5) return;
  const color = mix(p.string('body'), p.string('shade'), 0.6);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.8, f.W * 0.004);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.45;
  for (const ear of earCentres(f, p)) {
    ctx.beginPath();
    let open = false;
    for (const [x, y] of outline) {
      const inside = Math.hypot(x - ear.x, y - ear.y) < R * 0.92;
      if (inside && !open) ctx.moveTo(x, y);
      else if (inside) ctx.lineTo(x, y);
      open = inside;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ face */

function drawFace(ctx: Ctx2D, f: Frame, p: Reader, rng: Rng): void {
  const { W } = f;
  const fx = p.number('faceX') * W;
  const muzzleC = p.string('muzzle');
  const noseC = p.string('nose');
  const gaps = p.number('bristleGaps');
  const rough = p.number('edgeRough');
  const brush = new Brush(f.view);

  const noseY = p.number('noseY') * W;
  const nw = (p.number('noseWidth') * W) / 2;
  const nh = (p.number('noseHeight') * W) / 2;
  const my = p.number('muzzleY') * W;
  const mw = (p.number('muzzleWidth') * W) / 2;
  const mh = (p.number('muzzleHeight') * W) / 2;
  const eyeY = p.number('eyeY') * W;

  // Muzzle: chalky opaque egg, ragged rim, scumbled with lighter and greyer strokes.
  if (mw > 0.5 && mh > 0.5) {
    const rm = rng.fork('muzzle');
    const rim = egg(rm, fx, my, mw, mh, 0.22, 2.1, 0.012 * rough);
    const reach = rough * (0.6 + W * 0.003);
    ctx.fillStyle = muzzleC;
    ctx.beginPath();
    tracePoly(ctx, rim);
    ctx.fill();
    if (rough > 0) {
      const loop = [...rim, ...rim.slice(0, 4)];
      ragStroke(brush, rm, loop, 0, loop.length - 1, reach, gaps * 0.8, muzzleC);
      brush.flush(ctx);
    }
    ctx.save();
    ctx.beginPath();
    tracePoly(ctx, rim);
    ctx.clip();
    const grey = mix(muzzleC, '#7d839c', 0.3);
    const chalk = mix(muzzleC, '#ffffff', 0.75);
    const nS = Math.min(260, Math.round((mw * mh) / (W * W * 0.0006)));
    for (let i = 0; i < nS; i++) {
      const a = rm.range(0, Math.PI * 2);
      const rr = Math.sqrt(rm.next()) * rm.range(0.55, 1.02);
      const px = fx + Math.sin(a) * mw * rr;
      const py = my - Math.cos(a) * mh * rr;
      // Tangent to the rim, like a brush worked round the muzzle.
      const tx = Math.cos(a) * mw;
      const ty = Math.sin(a) * mh;
      const tl = Math.hypot(tx, ty) || 1;
      const len = W * rm.range(0.03, 0.1);
      const hx = (tx / tl) * len * 0.5;
      const hy = (ty / tl) * len * 0.5;
      const isGrey = rm.next() < 0.5;
      // Near the rim the brush follows the edge; toward the middle it drags down.
      const along = rr > 0.85 ? 0.7 : 0.15;
      const vx = hx * along;
      const vy = hy * along + (1 - along) * len * 0.5;
      dryStroke(brush, rm, {
        x0: px - vx, y0: py - vy, cx: px + (vy * 0.2), cy: py - (vx * 0.2), x1: px + vx, y1: py + vy,
        width: W * rm.range(0.006, 0.016), bristles: rm.int(1, 4),
        color: isGrey ? grey : chalk, alpha: isGrey ? rm.range(0.08, 0.3) * rr : rm.range(0.25, 0.6) * (1.1 - rr * 0.5), gaps,
      });
    }
    brush.flush(ctx);
    ctx.restore();
  }

  drawNose(ctx, brush, f, p, rng.fork('nose'), fx, noseY, nw, nh, noseC, rough, gaps);

  // Mouth: a line dropping from the nose into a small smile.
  const lw = p.number('lineWeight') * W;
  const rmth = rng.fork('mouth');
  const by = noseY + nh + p.number('mouthDrop') * W;
  const bx = fx + p.number('mouthSkew') * W;
  const sw = (p.number('smileWidth') * W) / 2;
  const sd = p.number('smileDepth') * W;
  const startY = noseY + nh * 0.7;
  taper(ctx, noseC, lw, fx, startY, (fx + bx) / 2 + rmth.range(-0.01, 0.01) * W, (startY + by) / 2, bx, by, 0.7);
  if (sw > 0.5) {
    taper(ctx, noseC, lw, bx - sw, by - sd, bx + rmth.range(-0.1, 0.1) * sw, by + sd, bx + sw, by - sd * 0.9, 0.35);
  }

  // Eyes and brows.
  const pr = p.number('eyeSize') * W;
  const whiteR = p.number('eyeWhite') * pr;
  const es = p.number('eyeSpacing') * W;
  const lookX = p.number('lookX');
  const lookY = p.number('lookY');
  const re = rng.fork('eyes');
  const browLift = p.number('browLift') * W;
  const browHalf = (p.number('browLength') * W) / 2;
  const browAngle = p.number('browAngle') * DEG;
  for (const side of [-1, 1]) {
    const ex = fx + side * es;
    let px = ex;
    let py = eyeY;
    if (whiteR > pr * 1.05) {
      const ry = whiteR * 0.84;
      ctx.fillStyle = EYE_WHITE;
      ctx.beginPath();
      tracePoly(ctx, blob(re, ex, eyeY, whiteR, ry, 0.05));
      ctx.fill();
      px = ex + lookX * (whiteR - pr * 0.95);
      py = eyeY + lookY * (ry - pr * 0.9);
    }
    ctx.fillStyle = noseC;
    ctx.beginPath();
    tracePoly(ctx, blob(re, px, py, pr, pr * 1.05, 0.06));
    ctx.fill();
    if (browHalf > 0.5) {
      // Inner end is the one nearer the face centre; positive angle raises it.
      const a = side * browAngle;
      const cx = ex;
      const cy = eyeY - browLift;
      const dx = Math.cos(a) * browHalf;
      const dy = Math.sin(a) * browHalf;
      taper(ctx, noseC, lw * 1.35, cx - dx, cy - dy, cx + re.range(-0.1, 0.1) * browHalf, cy - browHalf * 0.25, cx + dx, cy + dy, 0.3);
    }
  }
}

function drawNose(
  ctx: Ctx2D, brush: Brush, f: Frame, p: Reader, rng: Rng,
  fx: number, ny: number, nw: number, nh: number, color: string, rough: number, gaps: number,
): void {
  if (nw < 0.5 || nh < 0.5) return;
  const rim = egg(rng, fx, ny, nw, nh, -0.24, 2.35, 0.015 * rough);
  ctx.fillStyle = color;
  ctx.beginPath();
  tracePoly(ctx, rim);
  ctx.fill();
  if (rough > 0) {
    const loop = [...rim, ...rim.slice(0, 4)];
    ragStroke(brush, rng, loop, 0, loop.length - 1, rough * (0.5 + f.W * 0.002), gaps * 0.8, color);
  }
  // Faint sheen strokes so the black is not dead flat.
  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, rim);
  ctx.clip();
  const sheen = mix(color, '#8890a8', 0.35);
  for (let i = 0; i < 10; i++) {
    const x = fx + rng.range(-0.7, 0.7) * nw;
    const y = ny + rng.range(-0.2, 0.7) * nh;
    const len = nw * rng.range(0.2, 0.6);
    dryStroke(brush, rng, {
      x0: x - len / 2, y0: y, cx: x, cy: y + rng.range(-0.1, 0.1) * nh, x1: x + len / 2, y1: y + rng.range(-0.1, 0.1) * nh,
      width: nh * rng.range(0.04, 0.1), bristles: 2, color: sheen, alpha: rng.range(0.1, 0.25), gaps,
    });
  }
  brush.flush(ctx);
  ctx.restore();

  const g = p.number('glint');
  if (g > 0) {
    const hx0 = fx - nw * 0.62 * g;
    const hy0 = ny - nh * 0.42;
    const hx1 = fx + nw * (0.42 * g - 0.12);
    const hy1 = ny - nh * (0.45 + 0.1 * g);
    taper(ctx, HIGHLIGHT, nh * 0.17 * g + 0.5, hx0, hy0, (hx0 + hx1) / 2, hy1 - nh * 0.08, hx1, hy1, 0.45);
  }
}

/* ------------------------------------------------------------------ shapes */

/** A wobbly ellipse as a closed polygon. `wobble` is relative to the radii. */
function blob(rng: Rng, cx: number, cy: number, rx: number, ry: number, wobble: number): Pt[] {
  const k = Math.max(12, Math.min(72, Math.round((rx + ry) / 3)));
  const w = noise1(rng, 6);
  const pts: Pt[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const m = 1 + w(i / k) * wobble;
    pts.push([cx + Math.cos(a) * rx * m, cy + Math.sin(a) * ry * m]);
  }
  return pts;
}

/**
 * An egg: superellipse with exponent `sq`, narrower at the top for positive
 * `taperK` and wider at the top for negative. Starts at the top, clockwise.
 */
function egg(rng: Rng, cx: number, cy: number, hw: number, hh: number, taperK: number, sq: number, wobble: number): Pt[] {
  const k = Math.max(16, Math.min(90, Math.round((hw + hh) / 3)));
  const w = noise1(rng, 7);
  const e = 2 / sq;
  const pts: Pt[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const s = Math.sin(a);
    const co = Math.cos(a);
    const m = 1 + w(i / k) * wobble;
    const x = Math.sign(s) * Math.abs(s) ** e * hw * (1 - taperK * co);
    const y = -Math.sign(co) * Math.abs(co) ** e * hh;
    pts.push([cx + x * m, cy + y * m]);
  }
  return pts;
}

/** A filled brush line along a quadratic, full width in the middle and thinner (by `endScale`) at the ends. */
function taper(
  ctx: Ctx2D, color: string, width: number,
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, endScale: number,
): void {
  if (!(width > 0.2)) return;
  const k = 14;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= k; i++) {
    const t = i / k;
    const u = 1 - t;
    const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
    const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
    let tx = 2 * u * (cx - x0) + 2 * t * (x1 - cx);
    let ty = 2 * u * (cy - y0) + 2 * t * (y1 - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const h = (width / 2) * (endScale + (1 - endScale) * Math.sin(Math.PI * t) ** 0.6);
    left.push([x - ty * h, y + tx * h]);
    right.push([x + ty * h, y - tx * h]);
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  tracePoly(ctx, [...left, ...right.reverse()]);
  ctx.fill();
  // Round the ends.
  const capR = (width / 2) * endScale;
  if (capR > 0.3) {
    ctx.beginPath();
    ctx.arc(x0, y0, capR, 0, Math.PI * 2);
    ctx.arc(x1, y1, capR, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Loose circular scribble made of short arc strokes, for inner ears and shade patches. */
function scribble(
  brush: Brush, rng: Rng, cx: number, cy: number, r: number, count: number, color: string, alpha: number, width: number,
): void {
  if (r < 0.5 || alpha <= 0) return;
  for (let i = 0; i < count; i++) {
    const rho = r * rng.range(0.2, 0.75);
    // Each loop gets its own centre so the scribble does not read as a target.
    const ox = cx + rng.range(-0.35, 0.35) * r;
    const oy = cy + rng.range(-0.35, 0.35) * r;
    const a0 = rng.range(0, Math.PI * 2);
    const sweep = rng.range(0.8, 1.3) * (rng.next() < 0.5 ? -1 : 1);
    const squash = rng.range(0.8, 1.1);
    const pt = (a: number): Pt => [ox + Math.cos(a) * rho, oy + Math.sin(a) * rho * squash];
    const [sx, sy] = pt(a0);
    const [ex, ey] = pt(a0 + sweep);
    const mid = a0 + sweep / 2;
    const k = rho / Math.cos(sweep / 2);
    dryStroke(brush, rng, {
      x0: sx, y0: sy, cx: ox + Math.cos(mid) * k, cy: oy + Math.sin(mid) * k * squash, x1: ex, y1: ey,
      width: width * rng.range(0.7, 1.4), bristles: 2, color, alpha: alpha * rng.range(0.5, 1), gaps: 0.4,
    });
  }
}
