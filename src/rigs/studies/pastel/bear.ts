// PROTOTYPE oil-pastel bear for the pastel study (scenes/bears-pastel.json).
import type { Ctx2D, ParamSchema, Rig, Rng } from '../../../engine/types';
import { degToRad } from '../../parts/math';
import { readParams, type ParamReader } from '../../parts/params';
import { mix } from './color';
import { crayon, isNone, makePaper, Palette, type Paper } from './crayon';
import {
  child,
  closedNormals,
  depth,
  eggPoints,
  frame,
  mapPts,
  resampleClosed,
  roundPolygon,
  sampleRounded,
  smoothstep,
  toLocal,
  toScene,
  wobble,
  type Frame,
  type Outline,
  type Pt,
} from './geom';
import { blade, contourBand, fillPolygon, hatch, inset, tangle, tracePolygon } from './strokes';
import { valueNoise } from './tooth';

const num = (def: number, min: number, max: number, description: string) =>
  ({ type: 'number', default: def, min, max, description }) as const;
const color = (def: string, description: string) => ({ type: 'color', default: def, description }) as const;

const params: ParamSchema = {
  // Body
  x: num(540, -10000, 10000, 'Scene x of the middle of the top of the head.'),
  y: num(700, -10000, 10000, 'Scene y of the top of the head.'),
  width: num(560, 10, 5000, 'Body width across the top of the head, px.'),
  height: num(1400, 10, 10000, 'Body length from the top of the head down, px. Make it run off the stage for a bust.'),
  flareLeft: num(0.08, -0.3, 1, 'How far the left side leans out per pixel down (0 is vertical).'),
  flareRight: num(0.08, -0.3, 1, 'How far the right side leans out per pixel down (0 is vertical).'),
  corner: num(80, 0, 2500, 'Radius of the rounded head corners, px.'),
  dome: num(12, 0, 2000, 'How far the middle of the top of the head bulges up above the corners, px.'),
  tilt: num(0, -45, 45, 'Whole-bear rotation about the top of the head, degrees clockwise.'),
  // Ears
  earSize: num(46, 0, 1000, 'Ear radius, px.'),
  earLeftX: num(-235, -5000, 5000, 'Left ear centre x, relative to the top of the head (rotates with tilt).'),
  earLeftY: num(12, -5000, 5000, 'Left ear centre y, relative to the top of the head.'),
  earRightX: num(235, -5000, 5000, 'Right ear centre x, relative to the top of the head.'),
  earRightY: num(12, -5000, 5000, 'Right ear centre y, relative to the top of the head.'),
  innerEarSize: num(0.55, 0, 1, 'Inner ear radius as a fraction of the ear radius.'),
  // Face
  faceX: num(0, -5000, 5000, 'Nose centre x, relative to the top of the head.'),
  faceY: num(210, -5000, 5000, 'Nose centre y, relative to the top of the head.'),
  headTilt: num(0, -45, 45, 'Extra rotation of the face about the nose, degrees clockwise.'),
  noseWidth: num(130, 0, 2000, 'Nose width, px.'),
  noseHeight: num(88, 0, 2000, 'Nose height, px.'),
  noseTaper: num(-0.2, -0.8, 0.8, 'Nose shape: below 0 narrows the bottom, above 0 narrows the top.'),
  muzzleX: num(0, -2000, 2000, 'Muzzle centre x, relative to the nose centre.'),
  muzzleY: num(60, -2000, 2000, 'Muzzle centre y, relative to the nose centre.'),
  muzzleWidth: num(160, 0, 3000, 'Muzzle width, px.'),
  muzzleHeight: num(165, 0, 3000, 'Muzzle height, px.'),
  muzzleTaper: num(0.12, -0.8, 0.8, 'Muzzle shape: above 0 narrows the top, below 0 narrows the bottom.'),
  muzzleSquare: num(2.6, 2, 6, 'Muzzle squareness: 2 is an oval, higher is boxier.'),
  eyeSpacing: num(160, 0, 3000, 'Distance between the eye centres, px.'),
  eyeX: num(0, -2000, 2000, 'Eye pair centre x, relative to the nose centre.'),
  eyeY: num(-50, -2000, 2000, 'Eye pair centre y, relative to the nose centre (negative is above).'),
  eyeSize: num(11, 0, 200, 'Eye radius, px. With eye whites this is the white; the pupil is a bit over half of it.'),
  eyeWhites: { type: 'boolean', default: true, description: 'On: white eyes with a black pupil. Off: plain black dot eyes.' },
  lookX: num(0.6, -1, 1, 'Pupil direction, -1 left to 1 right.'),
  lookY: num(-0.3, -1, 1, 'Pupil direction, -1 up to 1 down.'),
  browY: num(-26, -500, 500, 'Brow height relative to each eye centre (negative is above).'),
  browOut: num(4, -200, 200, 'Brow shift away from the nose, px.'),
  browLength: num(34, 0, 500, 'Brow length, px.'),
  browTilt: num(14, -60, 60, 'Brow angle, degrees; above 0 lifts the inner ends (a soft, worried look).'),
  mouthX: num(0, -500, 500, 'Mouth line x, relative to the nose centre.'),
  mouthDrop: num(60, 0, 1000, 'Length of the line from the bottom of the nose to the bottom of the smile, px.'),
  smileWidth: num(76, 0, 1000, 'Width of the smile, px.'),
  smileDepth: num(18, -200, 200, 'How far the smile ends rise above its bottom, px.'),
  lineWidth: num(4, 0.5, 40, 'Crayon width of the mouth, px; brows are a little heavier.'),
  // Shading
  bridge: num(0.75, 0, 1, 'Strength of the darker nose bridge between the eyes.'),
  bridgeLength: num(80, 0, 1000, 'How far the nose bridge reaches up from the nose centre, px.'),
  chin: num(0.7, 0, 1, 'Strength of the shadow under the muzzle.'),
  chinX: num(-10, -1000, 1000, 'Chin shadow offset x from the muzzle, px.'),
  chinY: num(22, -1000, 1000, 'Chin shadow offset y from the muzzle, px.'),
  chinSize: num(1.05, 0, 3, 'Chin shadow size as a multiple of the muzzle size.'),
  patchAmount: num(0, 0, 1, 'Strength of a free shade patch on the body, for where another bear overlaps. 0 is off.'),
  patchX: num(0, -5000, 5000, 'Shade patch centre x, relative to the top of the head (rotates with tilt).'),
  patchY: num(500, -5000, 10000, 'Shade patch centre y, relative to the top of the head.'),
  patchWidth: num(120, 0, 3000, 'Shade patch width, px.'),
  patchHeight: num(300, 0, 3000, 'Shade patch height, px.'),
  patchAngle: num(0, -180, 180, 'Shade patch rotation, degrees clockwise.'),
  patchScribble: { type: 'boolean', default: false, description: 'On: work the shade patch as a tangle of loops. Off: hatch it along its long axis.' },
  // Colours
  color: color('#ef4921', 'Body colour.'),
  shade: color('#d63714', 'Darker pastel for the nose bridge, chin shadow, shade patch and dark streaks.'),
  scratch: color('#ffffff', 'Colour exposed by the sgraffito scratches and mixed into the light streaks.'),
  muzzle: color('#ffffff', 'Muzzle colour.'),
  muzzleLine: color('#c8cddc', 'Colour of the scribbles worked into the muzzle.'),
  innerEar: color('#f5693f', 'Inner ear colour.'),
  ink: color('#101010', 'Black for the nose, pupils, brows and mouth.'),
  white: color('#ffffff', 'Chalk white for the eye whites and the nose highlight.'),
  // Pastel texture
  streakAngle: num(8, -60, 60, 'Lean of the hatching, streaks and scratches, degrees; above 0 tips their tops to the right.'),
  hatching: num(1, 0, 3, 'Amount of near-tone directional hatching worked over the body colour.'),
  density: num(1, 0, 3, 'Density of the light and dark dry streaks over the body.'),
  scratches: num(1, 0, 3, 'Density of the thin light sgraffito scratches.'),
  band: num(12, 0, 60, 'Width of the waxy edge band where the pastel thins out and the paper shows, px.'),
  roughness: num(1, 0, 5, 'Hand wobble of the outlines.'),
  pressure: num(0.85, 0.2, 1, 'Overall pressure: lower lets more paper tooth show through every stroke.'),
  grain: num(0.9, 0, 1, 'Paper tooth strength: 0 gives solid strokes, 1 lets the tooth break every light stroke.'),
  toothScale: num(1, 0.3, 4, 'Size of the paper tooth. Keep it equal across layers so the grain lines up.'),
  strokeWidth: num(2.6, 0.5, 12, 'Width of the pastel stick, px.'),
};

interface Ctx {
  ctx: Ctx2D;
  p: ParamReader;
  paper: Paper;
  pal: Palette;
  sw: number;
  pressure: number;
  rough: number;
}

/** Closed outline from local points in a frame: wobble, then map to scene with scene normals. */
function outlineFrom(f: Frame, localPts: readonly number[], step: number, wob: number, rng: Rng): Outline {
  const even = resampleClosed(localPts, step);
  const n0 = closedNormals(even.pts);
  const wobbled = wob > 0 ? wobble(even.pts, n0, even.spacing, wob, rng) : even.pts;
  const pts = mapPts(f, wobbled);
  const normals: number[] = [];
  for (let i = 0; i < n0.length; i += 2) normals.push(n0[i] * f.cos - n0[i + 1] * f.sin, n0[i] * f.sin + n0[i + 1] * f.cos);
  return { pts, normals, spacing: even.spacing };
}

export const pastelBear: Rig = {
  id: 'pastel-bear',
  description:
    'PROTOTYPE oil-pastel bear: a tall tombstone body running off the stage with round ears, dot or white eyes, a pale ' +
    'muzzle, a glossy black nose and a line smile. Colour goes on as crayon strokes that break up on a paper tooth ' +
    'shared by every pastel layer: waxy edges, near-tone directional hatching, dry light and dark streaks, tapered ' +
    'sgraffito scratches, hatched or scribbled shade patches, and heavy white over colour for the muzzle and highlights.',
  params,
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const c: Ctx = {
      ctx,
      p,
      paper: makePaper(stage.width, stage.height, p.number('toothScale'), p.number('grain')),
      pal: new Palette(),
      sw: p.number('strokeWidth'),
      pressure: p.number('pressure'),
      rough: p.number('roughness'),
    };
    const body = frame(p.number('x'), p.number('y'), degToRad(p.number('tilt')));
    const face = child(body, p.number('faceX'), p.number('faceY'), degToRad(p.number('headTilt')));

    ctx.save();
    const earL = drawEar(c, body, p.number('earLeftX'), p.number('earLeftY'), rng.fork('earL'));
    const earR = drawEar(c, body, p.number('earRightX'), p.number('earRightY'), rng.fork('earR'));
    const shape = drawBody(c, body, rng.fork('body'));

    ctx.save();
    tracePolygon(ctx, shape.outline.pts);
    ctx.clip();
    const clear = faceClearing(c, face);
    drawHatching(c, body, shape, rng.fork('hatching'));
    drawStreaks(c, body, shape, clear, rng.fork('streaks'));
    drawPatch(c, body, rng.fork('patch'));
    drawBridge(c, face, rng.fork('bridge'));
    drawChin(c, face, rng.fork('chin'));
    drawScratches(c, body, shape, clear, rng.fork('scratches'));
    ctx.restore();
    // The inner ears go on after the head so the head's corner never cuts them.
    if (earL) drawInnerEar(c, earL, rng.fork('innerL'));
    if (earR) drawInnerEar(c, earR, rng.fork('innerR'));

    drawMuzzle(c, face, rng.fork('muzzle'));
    drawNose(c, face, rng.fork('nose'));
    drawEyes(c, face, rng.fork('eyes'));
    drawMouth(c, face, rng.fork('mouth'));
    ctx.restore();
  },
};

interface BodyShape {
  outline: Outline;
  depthAt: (lx: number, ly: number) => number;
  /** Visible part of the body in scene pixels, clipped to the stage. */
  box: { x0: number; y0: number; x1: number; y1: number };
  visibleArea: number;
}

function drawBody(c: Ctx, f: Frame, rng: Rng): BodyShape {
  const { p, paper } = c;
  const W = p.number('width');
  const H = p.number('height');
  let fl = p.number('flareLeft');
  let fr = p.number('flareRight');
  // Keep the bottom at least 30% of the top width so the outline never folds over itself.
  if (W + (fl + fr) * H < 0.3 * W) {
    const k = (0.3 * W - W) / ((fl + fr) * H);
    fl *= k;
    fr *= k;
  }
  const bottom = W + (fl + fr) * H;
  const r = Math.min(p.number('corner'), 0.49 * Math.min(W, H, bottom));
  // The top is a shallow parabola between the corners, kept clear of the corner arcs so the rounding stays valid.
  const dome = Math.min(p.number('dome'), W);
  const verts: Pt[] = [
    [-W / 2 - fl * H, H],
    [-W / 2, 0],
  ];
  const inner = W / 2 - 1.15 * r;
  if (dome > 0 && inner > 0) {
    for (let i = 0; i <= 8; i++) {
      const x = -inner + (2 * inner * i) / 8;
      verts.push([x, -dome * (1 - ((2 * x) / W) ** 2)]);
    }
  }
  verts.push([W / 2, 0], [W / 2 + fr * H, H]);
  const poly = roundPolygon(verts, r);
  const local = sampleRounded(poly, 5);
  const outline = outlineFrom(f, local.pts, 5, c.rough, rng.fork('edge'));

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < outline.pts.length; i += 2) {
    x0 = Math.min(x0, outline.pts[i]);
    x1 = Math.max(x1, outline.pts[i]);
    y0 = Math.min(y0, outline.pts[i + 1]);
    y1 = Math.max(y1, outline.pts[i + 1]);
  }
  const box = { x0: Math.max(x0, paper.x0), y0: Math.max(y0, paper.y0), x1: Math.min(x1, paper.x1), y1: Math.min(y1, paper.y1) };
  const depthAt = (lx: number, ly: number) => depth(poly, lx, ly);
  let visibleArea = 0;
  if (box.x1 > box.x0 && box.y1 > box.y0) {
    const probe = rng.fork('area');
    let hits = 0;
    const tries = 400;
    for (let i = 0; i < tries; i++) {
      const [lx, ly] = toLocal(f, probe.range(box.x0, box.x1), probe.range(box.y0, box.y1));
      if (depthAt(lx, ly) > 0) hits++;
    }
    visibleArea = ((box.x1 - box.x0) * (box.y1 - box.y0) * hits) / tries;
  }

  const bodyColor = p.string('color');
  const band = p.number('band');
  fillPolygon(c.ctx, inset(outline, Math.min(2.5, band * 0.2)), bodyColor);
  const sticks = [c.pal.stick(bodyColor, c.sw * 0.8), c.pal.stick(bodyColor, c.sw)];
  contourBand(
    sticks,
    outline,
    { band, outer: 0.6, coats: 2.4, inner: 1.1, edge: Math.min(1, 1.1 * c.pressure), lenMin: 30, lenMax: 130, lanes: 2 },
    paper,
    rng.fork('band'),
  );
  c.pal.flush(c.ctx);
  return { outline, depthAt, box, visibleArea };
}

interface EarShape {
  frame: Frame;
  outline: Outline;
  side: number;
}

/** The outer ear, laid before the body so the head overlaps it. */
function drawEar(c: Ctx, body: Frame, ex: number, ey: number, rng: Rng): EarShape | null {
  const { p, paper } = c;
  const R = p.number('earSize');
  if (!(R > 1)) return null;
  const bodyColor = p.string('color');
  const ear = child(body, ex, ey, 0);
  const ring = eggPoints(R, R, 0, 2, Math.max(24, Math.round((2 * Math.PI * R) / 4)));
  const outline = outlineFrom(ear, ring, 4, c.rough * 0.5, rng.fork('edge'));
  const band = Math.min(p.number('band') * 0.6, R * 0.4);
  fillPolygon(c.ctx, inset(outline, Math.min(2.5, band * 0.2)), bodyColor);
  contourBand(
    [c.pal.stick(bodyColor, c.sw * 0.8)],
    outline,
    { band, outer: 0.5, coats: 2.4, inner: 1.1, edge: Math.min(1, 1.1 * c.pressure), lenMin: 16, lenMax: Math.max(20, R), lanes: 2 },
    paper,
    rng.fork('band'),
  );
  c.pal.flush(c.ctx);
  return { frame: ear, outline, side: ex < 0 ? -1 : 1 };
}

/** Inner ear: a disc of round strokes worked into the ear, nudged toward the head, clipped to the ear. */
function drawInnerEar(c: Ctx, ear: EarShape, rng: Rng): void {
  const { p, paper, pal } = c;
  const R = p.number('earSize');
  const ir = R * p.number('innerEarSize');
  const inner = p.string('innerEar');
  const bodyColor = p.string('color');
  c.ctx.save();
  tracePolygon(c.ctx, inset(ear.outline, Math.min(3, R * 0.08)));
  c.ctx.clip();
  if (ir > 1) {
    const ix = -ear.side * R * 0.08;
    const iy = R * 0.06;
    const inF = child(ear.frame, ix, iy, 0);
    const tints = [
      pal.stick(inner, c.sw * 0.9),
      pal.stick(inner, c.sw * 0.75),
      pal.stick(mix(inner, bodyColor, 0.35), c.sw * 0.7),
      pal.stick(mix(inner, p.string('shade'), 0.3), c.sw * 0.6),
    ];
    tangle(tints, inF, ir, ir, Math.min(160, Math.round(20 + ir * 1.8)), (edge) => 1 - 0.3 * edge, paper, rng);
    pal.flush(c.ctx);
  }
  c.ctx.restore();
}

/** 0 over the face, rising to 1 away from it: painters keep the features clear of loose streaks. */
function faceClearing(c: Ctx, face: Frame): (x: number, y: number) => number {
  const { p } = c;
  const [fx, fy] = toScene(face, p.number('muzzleX') * 0.5, p.number('muzzleY') * 0.5);
  const reach = Math.max(8, 0.5 * Math.max(p.number('muzzleWidth'), p.number('muzzleHeight'), p.number('eyeSpacing') + 2 * p.number('eyeSize')));
  return (x, y) => 0.15 + 0.85 * smoothstep(0.7, 1.5, Math.hypot(x - fx, y - fy) / reach);
}

/** Direction of the streaks in the body frame: (dx, dy) running down, leaning by streakAngle. */
function streakDir(c: Ctx, jitter: number, rng: Rng): [number, number] {
  const a = -degToRad(c.p.number('streakAngle')) + rng.range(-jitter, jitter);
  return [Math.sin(a), Math.cos(a)];
}

/**
 * Near-tone hatching over the whole body: broad, fairly heavy strokes a shade
 * lighter or darker than the body, laid along the streak direction. The paper
 * tooth breaks their sides, so the flat colour reads as worked pastel.
 */
function drawHatching(c: Ctx, f: Frame, shape: BodyShape, rng: Rng): void {
  const { p, paper, pal } = c;
  const amount = p.number('hatching');
  if (amount <= 0 || shape.visibleArea <= 0) return;
  const body = p.string('color');
  const shade = p.string('shade');
  const scratch = p.string('scratch');
  const w = c.sw * 1.1;
  const sticks = [
    pal.stick(mix(body, scratch, 0.08), w, 0.8),
    pal.stick(mix(body, shade, 0.28), w, 0.8),
    pal.stick(mix(body, scratch, 0.04), w * 0.8, 0.8),
    pal.stick(mix(body, shade, 0.15), w * 0.8, 0.8),
  ];
  const count = Math.min(1600, Math.round((amount * shape.visibleArea) / 2600));
  const salt = rng.int(0, 1 << 20);
  const { box } = shape;
  const heavy = Math.min(1, c.pressure / 0.85);
  for (let i = 0, tries = 0; i < count && tries < count * 4; tries++) {
    const [lx, ly] = toLocal(f, rng.range(box.x0, box.x1), rng.range(box.y0, box.y1));
    if (shape.depthAt(lx, ly) <= 0) continue;
    i++;
    // Patches of the body lean lighter or darker, so the tone drifts like worked colour.
    const drift = valueNoise(lx / 160, ly / 160, salt);
    const pick = rng.next() < drift ? rng.int(0, 2) * 2 : 1 + rng.int(0, 2) * 2;
    const len = rng.range(40, 170);
    const [dx, dy] = streakDir(c, 0.12, rng);
    const bow = rng.range(-0.05, 0.05) * len;
    const pts = mapPts(f, [lx, ly, lx + dx * len * 0.5 + bow, ly + dy * len * 0.5, lx + dx * len, ly + dy * len]);
    crayon(sticks[pick], pts, rng.range(0.3, 0.6) * heavy, paper, { ramp: 0.35, lanes: 3 });
  }
  pal.flush(c.ctx);
}

/** Dry streaks: light-pressure strokes of lighter and darker pastel that catch on the tooth, crowding toward the edges. */
function drawStreaks(c: Ctx, f: Frame, shape: BodyShape, clear: (x: number, y: number) => number, rng: Rng): void {
  const { p, paper, pal } = c;
  const density = p.number('density');
  if (density <= 0 || shape.visibleArea <= 0) return;
  const body = p.string('color');
  const shade = p.string('shade');
  const scratch = p.string('scratch');
  const light = [pal.stick(mix(body, scratch, 0.3), c.sw * 0.8), pal.stick(mix(body, scratch, 0.5), c.sw * 0.65)];
  const dark = [pal.stick(mix(body, shade, 0.5), c.sw * 0.8), pal.stick(mix(body, shade, 0.85), c.sw * 0.65)];
  const count = Math.min(2000, Math.round((density * shape.visibleArea) / 3000));
  const ySpan = Math.max(1, paper.y1 - paper.y0);
  const salt = rng.int(0, 1 << 20);
  const heavy = Math.min(1, c.pressure / 0.85);
  const { box } = shape;
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 8; tries++) {
    const sx = rng.range(box.x0, box.x1);
    const sy = rng.range(box.y0, box.y1);
    const [lx, ly] = toLocal(f, sx, sy);
    const d = shape.depthAt(lx, ly);
    if (d <= 0) continue;
    const cluster = smoothstep(0.5, 0.8, valueNoise(lx / 130, ly / 130, salt));
    const low = smoothstep(0.45, 1, (sy - paper.y0) / ySpan);
    const weight = (0.02 + 0.9 * Math.exp(-d / 45) + 0.7 * cluster + 0.3 * low) * clear(sx, sy);
    if (rng.next() * 1.9 > weight) continue;
    placed++;
    const isLight = rng.next() < 0.78;
    const len = Math.exp(rng.range(Math.log(14), Math.log(110))) * (1 + 0.6 * Math.exp(-d / 60));
    const [dx, dy] = streakDir(c, 0.1, rng);
    const bow = rng.range(-0.04, 0.04) * len;
    const pts = mapPts(f, [lx, ly, lx + dx * len * 0.5 + bow, ly + dy * len * 0.5, lx + dx * len, ly + dy * len]);
    const pr = (isLight ? rng.range(0.25, 0.55) : rng.range(0.25, 0.5)) * heavy;
    const sticks = isLight ? light : dark;
    crayon(sticks[rng.int(0, sticks.length)], pts, pr, paper, { ramp: 0.35, lanes: 3 });
  }
  pal.flush(c.ctx);
}

/**
 * Sgraffito: thin tapered light lines scratched back through the colour, in
 * loose parallel groups, mostly near the edges and low on the body.
 */
function drawScratches(c: Ctx, f: Frame, shape: BodyShape, clear: (x: number, y: number) => number, rng: Rng): void {
  const { p, paper, pal } = c;
  const amount = p.number('scratches');
  if (amount <= 0 || shape.visibleArea <= 0) return;
  const body = p.string('color');
  const scratch = p.string('scratch');
  const tones = [pal.blades(mix(body, scratch, 0.45)), pal.blades(mix(body, scratch, 0.7)), pal.blades(mix(body, scratch, 0.95))];
  const groups = Math.min(1200, Math.round((amount * shape.visibleArea) / 4000));
  const ySpan = Math.max(1, paper.y1 - paper.y0);
  const salt = rng.int(0, 1 << 20);
  const thin = Math.max(0.6, c.sw * 0.55);
  const { box } = shape;
  let placed = 0;
  for (let tries = 0; placed < groups && tries < groups * 10; tries++) {
    const sx = rng.range(box.x0, box.x1);
    const sy = rng.range(box.y0, box.y1);
    const [lx, ly] = toLocal(f, sx, sy);
    const d = shape.depthAt(lx, ly);
    if (d <= 3) continue;
    const cluster = smoothstep(0.45, 0.8, valueNoise(lx / 110, ly / 110, salt));
    const low = smoothstep(0.5, 1, (sy - paper.y0) / ySpan);
    const weight = (0.03 + 0.9 * Math.exp(-d / 40) + 0.6 * cluster + 0.4 * low) * clear(sx, sy);
    if (rng.next() * 1.5 > weight) continue;
    placed++;
    // One flick of the tool leaves a few near-parallel lines of falling strength.
    const lines = rng.int(1, 6);
    const [dx, dy] = streakDir(c, 0.12, rng);
    const baseLen = Math.exp(rng.range(Math.log(12), Math.log(70)));
    let ox = 0;
    let oy = 0;
    for (let k = 0; k < lines; k++) {
      const len = baseLen * rng.range(0.5, 1.1);
      const x0 = lx + ox;
      const y0 = ly + oy;
      if (shape.depthAt(x0, y0) <= 2) break;
      const bow = rng.range(-0.06, 0.06) * len;
      const [ax, ay] = toScene(f, x0, y0);
      const [bx, by] = toScene(f, x0 + dx * len * 0.5 - dy * bow, y0 + dy * len * 0.5 + dx * bow);
      const [ex, ey] = toScene(f, x0 + dx * len, y0 + dy * len);
      const tone = Math.min(2, Math.floor(rng.next() * 3 * (k === 0 ? 1 : 0.7)));
      blade(tones[tone], ax, ay, bx, by, ex, ey, thin * rng.range(0.7, 1.8), rng.range(0.25, 0.6));
      ox += -dy * rng.range(2.5, 7) + dx * rng.range(-0.3, 0.3) * len;
      oy += dx * rng.range(2.5, 7) + dy * rng.range(-0.3, 0.3) * len;
    }
  }
  pal.flush(c.ctx);
}

function drawPatch(c: Ctx, f: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const amount = p.number('patchAmount');
  const w = p.number('patchWidth') / 2;
  const h = p.number('patchHeight') / 2;
  if (amount <= 0 || w < 1 || h < 1) return;
  const px = p.number('patchX');
  const py = p.number('patchY');
  const a = degToRad(p.number('patchAngle'));
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const field = (lx: number, ly: number) => {
    const dx = lx - px;
    const dy = ly - py;
    const u = (dx * ca + dy * sa) / w;
    const v = (-dx * sa + dy * ca) / h;
    return 1.7 * amount * (1 - smoothstep(0.5, 1, Math.hypot(u, v)));
  };
  const reach = Math.max(w, h);
  const shade = p.string('shade');
  if (p.boolean('patchScribble')) {
    const body = p.string('color');
    const sticks = [pal.stick(shade, c.sw * 0.8), pal.stick(mix(shade, body, 0.4), c.sw * 0.7), pal.stick(shade, c.sw * 0.6)];
    const loops = Math.min(160, Math.round((12 + (w * h) / 35) * amount));
    tangle(sticks, child(f, px, py, a), w, h, loops, (e) => amount * (1 - 0.45 * e), paper, rng);
    pal.flush(c.ctx);
    return;
  }
  hatch(
    [pal.stick(shade, c.sw * 0.5, 0.9), pal.stick(shade, c.sw * 0.4, 0.9)],
    f,
    { x0: px - reach, y0: py - reach, x1: px + reach, y1: py + reach },
    field,
    { angle: -a, spacing: c.sw * 1.1, segMin: 25, segMax: 90, wander: 0.05, lanes: 3, ramp: 0.08 },
    paper,
    rng,
  );
  pal.flush(c.ctx);
}

function drawBridge(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const amount = p.number('bridge');
  const len = p.number('bridgeLength');
  const nw = p.number('noseWidth');
  if (amount <= 0 || len < 2 || nw < 2) return;
  const top = -len;
  const nh = p.number('noseHeight');
  const field = (lx: number, ly: number) => {
    if (ly > nh * 0.2) return 0;
    const t = Math.min(1, Math.max(0, (ly - top) / len));
    const hw = nw * (0.2 + 0.26 * t);
    return 1.6 * amount * smoothstep(top - 2, top + 12, ly) * smoothstep(-2, 4, hw - Math.abs(lx));
  };
  const shade = p.string('shade');
  hatch(
    [pal.stick(shade, c.sw * 0.55), pal.stick(shade, c.sw * 0.45)],
    face,
    { x0: -nw * 0.5, y0: top - 4, x1: nw * 0.5, y1: nh * 0.2 },
    field,
    { angle: 0, spacing: c.sw * 1.1, segMin: 18, segMax: 55, wander: 0.06, lanes: 3, ramp: 0.06 },
    paper,
    rng,
  );
  pal.flush(c.ctx);
}

function drawChin(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const amount = p.number('chin');
  const rx = p.number('muzzleWidth') / 2;
  const ry = p.number('muzzleHeight') / 2;
  if (amount <= 0 || rx < 2 || ry < 2) return;
  const cx = p.number('muzzleX') + p.number('chinX');
  const cy = p.number('muzzleY') + p.number('chinY');
  const ex = rx * p.number('chinSize');
  const ey = ry * p.number('chinSize');
  const field = (lx: number, ly: number) => 2 * amount * (1 - smoothstep(0.84, 1, Math.hypot((lx - cx) / ex, (ly - cy) / ey)));
  const shade = p.string('shade');
  hatch(
    [pal.stick(shade, c.sw * 0.55), pal.stick(shade, c.sw * 0.45)],
    face,
    { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey },
    field,
    { angle: 0.15, spacing: c.sw * 1.1, segMin: 20, segMax: 60, wander: 0.06, lanes: 3, ramp: 0.06 },
    paper,
    rng,
  );
  pal.flush(c.ctx);
}

function drawMuzzle(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const rx = p.number('muzzleWidth') / 2;
  const ry = p.number('muzzleHeight') / 2;
  const muzzle = p.string('muzzle');
  if (rx < 2 || ry < 2 || isNone(muzzle)) return;
  const taper = p.number('muzzleTaper');
  const sq = p.number('muzzleSquare');
  const f = child(face, p.number('muzzleX'), p.number('muzzleY'), 0);
  const outline = outlineFrom(f, eggPoints(rx, ry, taper, sq, 96), 4, c.rough * 0.45, rng.fork('edge'));
  const band = Math.min(8, Math.min(rx, ry) * 0.3);
  fillPolygon(c.ctx, inset(outline, band * 0.4), muzzle);
  contourBand(
    [pal.stick(muzzle, c.sw * 0.7), pal.stick(muzzle, c.sw * 0.9)],
    outline,
    { band, outer: 0.6, coats: 2.8, inner: 1.1, edge: Math.min(1, 1.02 * c.pressure), lenMin: 16, lenMax: 60, lanes: 2 },
    paper,
    rng.fork('band'),
  );
  pal.flush(c.ctx);
  // Heavy white worked down the form: strokes run along the muzzle's meridians,
  // cool ones pressing harder toward the rim and the chin, chalky light ones inside.
  const line = p.string('muzzleLine');
  const cool = [pal.stick(line, c.sw * 0.55), pal.stick(mix(line, muzzle, 0.45), c.sw * 0.7)];
  const chalk = [pal.stick(mix(muzzle, '#ffffff', 0.75), c.sw * 0.8)];
  const n = Math.max(2, sq);
  const halfWidth = (y: number) => {
    const v = Math.min(1, Math.abs(y) / ry);
    const k = taper >= 0 ? 1 - taper * Math.max(0, -y / ry) : 1 + taper * Math.max(0, y / ry);
    return rx * k * Math.pow(Math.max(0, 1 - Math.pow(v, n)), 1 / n);
  };
  c.ctx.save();
  tracePolygon(c.ctx, inset(outline, 1));
  c.ctx.clip();
  const marks = Math.min(90, Math.round((rx + ry) / 4));
  const pts: number[] = [];
  for (let i = 0; i < marks; i++) {
    const isCool = rng.next() < 0.6;
    const u = isCool ? (rng.next() < 0.5 ? -1 : 1) * Math.sqrt(rng.range(0.1, 1)) : rng.range(-0.8, 0.8);
    const len = ry * rng.range(0.3, 0.9);
    const y0 = rng.range(-ry * 0.9, ry * 0.95 - len * 0.5);
    const y1 = Math.min(ry * 0.97, y0 + len);
    const steps = Math.max(3, Math.ceil((y1 - y0) / 8));
    pts.length = 0;
    const wig = rng.range(-0.04, 0.04);
    for (let j = 0; j <= steps; j++) {
      const y = y0 + ((y1 - y0) * j) / steps;
      pts.push(...toScene(f, (u + wig * Math.sin((Math.PI * j) / steps)) * halfWidth(y) * 0.96, y));
    }
    const low = Math.max(0, (y0 + y1) / (2 * ry));
    const press = isCool ? 0.18 + 0.4 * u * u + 0.2 * low : rng.range(0.35, 0.6);
    const sticks = isCool ? cool : chalk;
    crayon(sticks[rng.int(0, sticks.length)], pts, press * Math.min(1, c.pressure / 0.85), paper, { ramp: 0.3, lanes: 2 });
  }
  pal.flush(c.ctx);
  c.ctx.restore();
}

function drawNose(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const rx = p.number('noseWidth') / 2;
  const ry = p.number('noseHeight') / 2;
  const ink = p.string('ink');
  if (rx < 1 || ry < 1) return;
  const outline = outlineFrom(face, eggPoints(rx, ry, p.number('noseTaper'), 2.3, 72), 3, c.rough * 0.35, rng.fork('edge'));
  const band = Math.min(3, Math.min(rx, ry) * 0.3);
  fillPolygon(c.ctx, inset(outline, band * 0.2), ink);
  contourBand(
    [pal.stick(ink, c.sw * 0.55)],
    outline,
    { band, outer: 0.4, coats: 2.6, inner: 1.1, edge: 0.94, lenMin: 12, lenMax: 40, lanes: 3 },
    paper,
    rng.fork('band'),
  );
  pal.flush(c.ctx);
  // Waxy sheen: faint strokes of a lighter black following the rim, just inside it.
  c.ctx.save();
  tracePolygon(c.ctx, inset(outline, 2.5));
  c.ctx.clip();
  contourBand(
    [pal.stick(mix(ink, '#ffffff', 0.1), c.sw * 0.5)],
    outline,
    { band: Math.min(12, ry * 0.3), outer: 0, coats: 0.5, inner: 0.22, edge: 0.4, lenMin: 14, lenMax: 45, lanes: 2 },
    paper,
    rng.fork('sheen'),
  );
  pal.flush(c.ctx);
  c.ctx.restore();
  // Glossy highlight: a heavy white streak along the top, thick at the left end, with a small dab after it.
  const white = p.string('white');
  const hw = Math.max(1.5, ry * 0.17);
  const at = (x: number, y: number) => toScene(face, x, y);
  const h = pal.blades(white);
  blade(h, ...at(-rx * 0.6, -ry * 0.5), ...at(-rx * 0.1, -ry * 0.68), ...at(rx * 0.3, -ry * 0.52), hw, 0.3);
  blade(h, ...at(rx * 0.36, -ry * 0.5), ...at(rx * 0.43, -ry * 0.53), ...at(rx * 0.5, -ry * 0.47), hw * 0.6, 0.5);
  const pts: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    pts.push(...at(-rx * 0.55 + rx * 0.8 * u, -ry * 0.55 - ry * 0.07 * Math.sin(Math.PI * u)));
  }
  crayon(pal.stick(white, hw * 0.45), pts, 0.9, paper, { ramp: 0.3, strength: 0.5 });
  pal.flush(c.ctx);
}

function drawEyes(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const size = p.number('eyeSize');
  const spacing = p.number('eyeSpacing');
  const ink = p.string('ink');
  const white = p.string('white');
  const lw = p.number('lineWidth') * 1.3;
  for (const side of [-1, 1]) {
    const ex = p.number('eyeX') + (side * spacing) / 2;
    const ey = p.number('eyeY');
    const r = rng.fork(side < 0 ? 'left' : 'right');
    if (size > 0.5) {
      if (p.boolean('eyeWhites')) {
        const e = child(face, ex, ey, 0);
        fillPolygon(c.ctx, mapPts(e, eggPoints(size, size * 0.86, 0, 2, 32)), white);
        const pr = size * 0.64;
        const lx = p.number('lookX') * (size - pr * 0.8);
        const ly = p.number('lookY') * (size * 0.86 - pr * 0.8);
        fillPolygon(c.ctx, mapPts(child(e, lx, ly, 0), eggPoints(pr, pr, 0, 2, 24)), ink);
      } else {
        const e = child(face, ex, ey, 0);
        const dot = outlineFrom(e, eggPoints(size, size * 0.95, 0, 2, 32), 2, 0.3, r.fork('edge'));
        fillPolygon(c.ctx, dot.pts, ink);
      }
    }
    // Brow: a short heavy dash, inner end lifted by browTilt.
    const bl = p.number('browLength');
    if (bl > 1) {
      const bx = ex + side * p.number('browOut');
      const by = ey + p.number('browY');
      const a = degToRad(side * p.number('browTilt'));
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const pts: number[] = [];
      for (let i = 0; i <= 6; i++) {
        const u = i / 6 - 0.5;
        const ax = u * bl;
        const ay = -Math.cos(u * Math.PI) * bl * 0.1;
        pts.push(...toScene(face, bx + ax * ca - ay * sa, by + ax * sa + ay * ca));
      }
      crayon(pal.stick(ink, lw), pts, 1, paper, { ramp: 0.3, strength: 0.15 });
      crayon(pal.stick(ink, lw * 0.7), pts.map((v, i) => v + (i % 2 ? 0.8 : 0)), 0.9, paper, { ramp: 0.2, strength: 0.5 });
    }
  }
  pal.flush(c.ctx);
}

function drawMouth(c: Ctx, face: Frame, rng: Rng): void {
  const { p, paper, pal } = c;
  const ink = p.string('ink');
  const lw = p.number('lineWidth');
  const mx = p.number('mouthX');
  const top = p.number('noseHeight') * 0.42;
  const bottom = p.number('noseHeight') / 2 + p.number('mouthDrop');
  const sw = p.number('smileWidth') / 2;
  const sd = p.number('smileDepth');
  const stick = pal.stick(ink, lw);
  const bow = rng.range(-0.05, 0.05) * (bottom - top);
  if (bottom - top > 1) {
    const pts: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      pts.push(...toScene(face, mx * u + bow * Math.sin(Math.PI * u), top + (bottom - top) * u));
    }
    crayon(stick, pts, 1, paper, { ramp: 0.12, strength: 0.35 });
  }
  if (sw > 1) {
    const pts: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      const x = mx - sw + 2 * sw * u;
      // Quadratic through both ends and the bottom point.
      const y = (1 - u) * (1 - u) * (bottom - sd) + 2 * u * (1 - u) * (bottom + sd) + u * u * (bottom - sd);
      pts.push(...toScene(face, x, y));
    }
    crayon(stick, pts, 1, paper, { ramp: 0.2, strength: 0.35 });
  }
  pal.flush(c.ctx);
}
