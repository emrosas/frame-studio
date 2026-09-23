/**
 * bear: a tall tombstone-shaped bear painted in opaque gouache.
 *
 * The bear is built from the parts in BEAR_PARTS, each drawn by its own
 * functions inside kit.part(id, ...) with its own RNG fork, so hit testing and
 * selection masks can draw any subset of parts and get the same marks as the
 * full draw. `body` holds the cast shadow, the body paint and its shading
 * (nose bridge, chin, chest patch); `paws` is in bear-paws.ts. Every length is
 * a fraction of `width`, so one set of params draws the same character at any
 * size. The paint look comes from parts/paint.ts: opaque fills with ragged
 * bristle edges, dry-brush streaks that follow the body, tapered light
 * scratches bunched near the edges, soft washed shadows and thin darker rims.
 *
 * Animation: `pose` places the paws, `expression` offsets the face params,
 * blinks and breath follow seeded cycles in closed form on t (bear-motion.ts).
 * None of them touches the ears, body, muzzle or nose, so the character stays
 * the same from frame to frame. With `bodyLength` set, the body's paint is
 * laid out on the body instead of the stage, so it also holds still while
 * the bear moves.
 *
 * Frames: the body frame has its origin at the top centre of the head, y
 * down, turned by `tilt`. The face frame has its origin at the nose centre
 * (faceX, faceY in the body frame), turned a further `faceTilt`.
 */
import type { Ctx2D, DrawKit, ParamSchema, Params, Rig, Rng, Stage } from '../engine/types';
import { blinkClosure, breathCycle } from './bear-motion';
import { BEAR_POSES, drawPaws } from './bear-paws';
import { TAU, clamp, degToRad } from './parts/math';
import {
  Brush, Marks, brokenRim, dryStroke, edgeFlicks, eggPoints, fillPoly, lerp, mixColor, noise2, offsetPoly, outwardNormals,
  paintable, periodicNoise, quadPoints, ragEdge, resample, scribble, smoothstep, tracePoly, wash, washShape, wobble,
  EVERYWHERE, type Bounds, type EggShape, type Pt, type WashShape,
} from './parts/paint';
import { choice, col, num, readParams, type ParamReader } from './parts/params';

export { BEAR_POSES };
export const BEAR_EXPRESSIONS = ['neutral', 'happy', 'sad', 'surprised'] as const;
export type BearExpression = (typeof BEAR_EXPRESSIONS)[number];
export const BEAR_PARTS = ['ears', 'body', 'paws', 'muzzle', 'nose', 'eyes', 'mouth'] as const;

const params: ParamSchema = {
  // Body
  x: num(540, -10000, 10000, 'Scene x of the top centre of the head.'),
  y: num(700, -10000, 10000, 'Scene y of the top of the head. The body runs from here off the bottom of the stage.'),
  width: num(440, 40, 3000, 'Head width in scene pixels. Every other length is a fraction of this, so it scales the whole bear.'),
  tilt: num(-5, -45, 45, 'Tilt of the whole bear in degrees, clockwise, about the top centre of the head.'),
  flareLeft: num(0.15, 0, 0.8, 'How fast the left side widens going down, in pixels out per pixel down.'),
  flareRight: num(0.15, 0, 0.8, 'How fast the right side widens going down, in pixels out per pixel down.'),
  corner: num(0.24, 0.02, 0.5, 'Width of each rounded top corner, as a fraction of width.'),
  shoulderLeft: num(1, 0.1, 5, 'Height of the left top corner as a multiple of its width. Above 1 the side curves in over a longer run.'),
  shoulderRight: num(1, 0.1, 5, 'Height of the right top corner as a multiple of its width.'),
  dome: num(0.02, -0.1, 0.2, 'How much the top edge bulges up in the middle, as a fraction of width.'),
  bodyLength: num(0, 0, 8, 'Body length below the top of the head, as a multiple of width. 0 runs the body just past the bottom of the stage and lays its paint out for that spot, which suits a still. Set it long enough to leave the stage (for example 2) on a bear that moves or breathes, so its paint marks stay put on the body.'),

  // Ears
  earSize: num(0.1, 0, 0.3, 'Ear radius, as a fraction of width.'),
  earLeftX: num(-0.46, -1, 1, 'Left ear centre x in the body frame, as a fraction of width.'),
  earLeftY: num(0, -0.5, 0.5, 'Left ear centre y below the top edge, as a fraction of width. Negative is up.'),
  earRightX: num(0.46, -1, 1, 'Right ear centre x in the body frame, as a fraction of width.'),
  earRightY: num(0, -0.5, 0.5, 'Right ear centre y below the top edge, as a fraction of width.'),
  earLeftAspect: num(1, 0.5, 2, 'Left ear height over its width. 1 is round, above 1 an upright oval.'),
  earRightAspect: num(1, 0.5, 2, 'Right ear height over its width.'),
  earLean: num(0, -45, 45, 'How far the tall axis of an oval ear leans outward, in degrees.'),
  innerEarSize: num(0.6, 0, 1, 'Size of the inner-ear patch as a fraction of the ear radius. 0 hides it.'),

  // Face placement
  faceX: num(0, -0.5, 0.5, 'Nose centre x in the body frame, as a fraction of width. Moves the whole face.'),
  faceY: num(0.35, 0, 1.2, 'Nose centre y below the top edge, as a fraction of width.'),
  faceTilt: num(0, -45, 45, 'Extra turn of the face about the nose, in degrees clockwise.'),

  // Nose
  noseWidth: num(0.3, 0, 0.8, 'Nose width, as a fraction of width.'),
  noseHeight: num(0.2, 0, 0.6, 'Nose height, as a fraction of width.'),
  noseTaper: num(-0.25, -0.8, 0.8, 'Nose shape. Below 0 narrows the bottom for a bulbous, rounded-trapezoid nose.'),
  glint: num(1, 0, 1, 'Size of the white highlight on the nose, 0 to 1.'),

  // Muzzle
  muzzleX: num(0, -0.5, 0.5, 'Muzzle centre x relative to the nose centre, as a fraction of width.'),
  muzzleY: num(0.2, -0.5, 1, 'Muzzle centre y relative to the nose centre, as a fraction of width.'),
  muzzleWidth: num(0.36, 0, 1, 'Muzzle width, as a fraction of width.'),
  muzzleHeight: num(0.42, 0, 1.2, 'Muzzle height, as a fraction of width.'),
  muzzleTaper: num(0.15, -0.8, 0.8, 'Above 0 narrows the top of the muzzle toward the nose bridge.'),
  muzzleSquare: num(2.4, 2, 6, 'Muzzle squareness: 2 is an oval, higher is boxier.'),

  // Eyes and brows
  eyeX: num(0, -0.5, 0.5, 'Eye pair centre x relative to the nose centre, as a fraction of width.'),
  eyeY: num(-0.13, -0.8, 0.5, 'Eye pair centre y relative to the nose centre, as a fraction of width. Negative is above.'),
  eyeSpacing: num(0.38, 0, 1, 'Distance between the eye centres, as a fraction of width.'),
  eyeSize: num(0.022, 0.004, 0.08, 'Pupil radius, as a fraction of width.'),
  eyeWhite: num(1.7, 0, 3, 'Eye-white radius as a multiple of the pupil radius. Below about 1.05 the eye is a plain dot.'),
  lookX: num(0.6, -1, 1, 'Where the pupils look inside the eye whites, -1 left to 1 right.'),
  lookY: num(-0.2, -1, 1, 'Where the pupils look inside the eye whites, -1 up to 1 down.'),
  browY: num(-0.07, -0.3, 0.3, 'Brow height relative to each eye, as a fraction of width. Negative is above.'),
  browOut: num(0.01, -0.2, 0.2, 'Shifts each brow away from the nose, as a fraction of width.'),
  browLength: num(0.09, 0, 0.3, 'Brow length, as a fraction of width.'),
  browTilt: num(12, -60, 60, 'Brow slant in degrees. Above 0 lifts the inner ends for a soft, worried look.'),

  // Mouth
  mouthX: num(0, -0.2, 0.2, 'Sideways lean of the mouth line where it meets the smile, as a fraction of width.'),
  mouthDrop: num(0.17, 0, 0.6, 'Length of the line from the bottom of the nose to the bottom of the smile, as a fraction of width.'),
  smileWidth: num(0.18, 0, 0.6, 'Width of the smile, as a fraction of width.'),
  smileDepth: num(0.045, -0.15, 0.15, 'How far the smile dips below its ends, as a fraction of width. Negative frowns.'),
  lineWeight: num(0.011, 0.002, 0.04, 'Thickness of the mouth line, as a fraction of width. Brows are 1.6 times heavier.'),

  // Shading
  bridge: num(0.8, 0, 1, 'Strength of the darker wedge down the nose bridge, 0 to 1.'),
  bridgeTop: num(0.24, 0, 0.8, 'How far above the nose centre the bridge wedge starts, as a fraction of width.'),
  bridgeWidth: num(0.14, 0, 0.6, 'Width of the rounded top of the bridge wedge, as a fraction of width.'),
  chin: num(0.5, 0, 1, 'Strength of the soft shadow under the muzzle, 0 to 1.'),
  chinX: num(-0.03, -0.5, 0.5, 'Chin shadow offset x from the muzzle centre, as a fraction of width.'),
  chinY: num(0.07, -0.5, 0.5, 'Chin shadow offset y from the muzzle centre, as a fraction of width.'),
  chinSize: num(1.05, 0, 2, 'Chin shadow size as a multiple of the muzzle size.'),
  patch: num(0, 0, 1, 'Strength of a soft shade patch on the body, for example where another bear overlaps. 0 hides it.'),
  patchX: num(0, -1, 1, 'Shade patch centre x in the body frame, as a fraction of width.'),
  patchY: num(1.2, -0.5, 4, 'Shade patch centre y below the top edge, as a fraction of width.'),
  patchWidth: num(0.2, 0, 1.5, 'Shade patch width, as a fraction of width.'),
  patchHeight: num(0.3, 0, 3, 'Shade patch height, as a fraction of width.'),
  castLeft: num(0, 0, 1, 'Strength of the shadow this bear casts on whatever is left of it, 0 to 1.'),
  castRight: num(0, 0, 1, 'Strength of the shadow this bear casts on whatever is right of it, 0 to 1.'),
  castTop: num(0.1, 0, 1, 'Reach of the cast shadow just below the head corners, as a fraction of width.'),
  castWidth: num(0.4, 0, 1.5, 'Reach of the cast shadow where the body leaves the stage, as a fraction of width.'),
  rim: num(0.6, 0, 1, 'Strength of the thin darker line just inside the top of the head, 0 to 1.'),
  earRim: num(0.6, 0, 1, 'Strength of the thin line just inside each ear, 0 to 1.'),

  // Colours
  body: col('#f14922', 'Body paint colour.'),
  shade: col('#d6391a', 'Darker body tone for the nose bridge, chin shadow and darker streaks.'),
  rimColor: col('#c8321a', 'Colour of the thin line inside the ears and the top of the head.'),
  innerEar: col('#f98262', 'Colour of the scribbled loops inside the ears. A faint wash of it, half mixed with the body, goes under them.'),
  patchColor: col('#c9d0e6', 'Shade patch colour.'),
  muzzle: col('#ffffff', 'Muzzle paint colour.'),
  muzzleShade: col('#c9cedd', 'Cool colour worked into the muzzle rim and chin.'),
  scratch: col('#ffffff', 'Colour the light scratches mix toward.'),
  ink: col('#0e0c0d', 'Nose, pupil, brow and mouth colour.'),
  castLeftColor: col('#8fa6d6', 'Colour of the shadow cast to the left. It multiplies, so pale tints darken whatever is under them.'),
  castRightColor: col('#ebccb8', 'Colour of the shadow cast to the right. It multiplies, like castLeftColor.'),

  // Paint texture
  strokes: num(1, 0, 3, 'Density of the tonal and dry-brush streaks on the body. 0 leaves flat paint.'),
  tonal: num(0.6, 0, 1, 'How far the lighter and darker streak tints stray from the body colour, 0 to 1.'),
  scratches: num(1, 0, 3, 'Density of the thin tapered light scratches.'),
  scratchWidth: num(1, 0.2, 4, 'Width of the scratches as a multiple of a hairline that scales with width.'),
  edgeRough: num(1, 0, 3, 'Raggedness of paint edges: how far bristles drag past the outline and how much it wobbles.'),
  dryness: num(0.6, 0, 1, 'Dryness of the brush, 0 to 1. Higher gives more broken bristles.'),
  markSide: num(0, -1, 1, 'Which body edge collects more streaks and scratches, -1 left to 1 right.'),
  shadeSide: num(-0.6, -1, 1, 'Which side of the muzzle takes the cool rim, -1 left to 1 right.'),
  fringe: num(0, 0, 1, 'Width of the dry-brush fringe along the body edge, where whatever is underneath shows between bristle lines, 0 to 1.'),
  fringeSide: num(-1, -1, 1, 'Which body edge has the dry-brush fringe: below 0 the left, above 0 the right, 0 both.'),

  // Paws and pose
  pose: choice('idle', BEAR_POSES, 'Where the paws are: idle (low on the body front), wave (one paw raised beside the face, waving), cheer (both paws up above the head corners) or shy (both paws over the muzzle and cheeks).'),
  pawSize: num(0.2, 0, 0.5, 'Paw width, as a fraction of width. 0 hides the paws.'),
  wavePaw: choice('right', ['left', 'right'], 'Which paw waves in the wave pose, as seen on screen.'),
  waveSpeed: num(1.5, 0, 5, 'Waves per second in the wave pose. 0 holds the paw still.'),

  // Face animation
  expression: choice('neutral', BEAR_EXPRESSIONS, 'Expression: neutral, happy, sad or surprised. Moves the brows, mouth and eyes from their face params, so per-bear tuning still shows.'),
  blink: num(0, 0, 1, 'Eyelid closure by hand, 0 open to 1 shut. Adds to the automatic blinks.'),
  blinkRate: num(12, 0, 60, 'Automatic blinks per minute, on a seeded schedule. 0 turns them off. Eyes are always open at t = 0.'),
  breath: num(1, 0, 3, 'Strength of the idle breathing bob, 0 to 3. 0 holds the bear still.'),
};

const EYE_WHITE = '#fdfcf8';
/** At this eyelid closure and above, an eye is drawn shut: an ink line in its place. */
const SHUT = 0.8;
/** How far a full breath lifts the bear, as a fraction of width. */
const BREATH_LIFT = 0.008;
const HIGHLIGHT = '#fbfbf7';
/** Hard caps on mark counts, so extreme params stay cheap. */
const MAX_TONAL = 500;
const MAX_STREAKS = 1600;
const MAX_SCRATCH_GROUPS = 700;

type Reader = ParamReader;

/** The body's shape in its own frame, plus what the parts need to place marks. */
export interface Body {
  W: number;
  hw: number;
  fl: number;
  fr: number;
  /** Corner width, and the height of the left and right corners. */
  r: number;
  ryL: number;
  ryR: number;
  dome: number;
  /** Local y of the bottom edge: bodyLength, or where the body leaves the stage plus a margin. */
  L: number;
  /**
   * True when bodyLength fixes the body: marks are then laid out over the
   * whole body, whatever part of it is on stage, so they do not change as the bear moves.
   */
  fixed: boolean;
  /**
   * The stage's bounding box in the body frame. Marks wholly outside it are
   * dropped; on a fixed body they still keep their place in the paint order.
   */
  view: Bounds;
  /** Where marks are placed: the part of the body that can be on stage, or the whole body when fixed. */
  box: Bounds;
  outline: Pt[];
  normals: Pt[];
  /** Maps a body-frame point to scene pixels. */
  toScene: (x: number, y: number) => Pt;
  stage: Stage;
}

/**
 * Extra drawing a variant adds to the bear. `head` runs in the body frame
 * after the body part and before the face. It must draw inside its own
 * kit.part and leave the context state as it found it, so the base parts
 * draw exactly as they do without it.
 */
export interface BearHooks {
  head?(ctx: Ctx2D, body: Body, t: number): void;
}

export const bear: Rig = {
  id: 'bear',
  description:
    'A tall tombstone-shaped bear painted in opaque gouache: rounded head corners, a body that runs off the bottom of ' +
    'the stage, round or oval ears, stubby paws, dot or white eyes with brow dashes, a pale muzzle, a glossy black nose ' +
    'and a line smile. Paint look: ragged bristle edges, dry-brush streaks that follow the body, tapered light scratches ' +
    'bunched near the edges and low on the body, soft washed bridge, chin and cast shadows, and thin darker rims. Every ' +
    'length is a fraction of width. Animates with pose (idle, wave, cheer, shy), expression (neutral, happy, sad, ' +
    'surprised), seeded blinks and an idle breath.',
  params,
  parts: BEAR_PARTS,
  draw(ctx, values, t, rng, stage, kit) {
    drawBear(ctx, values, t, rng, stage, kit);
  },
};

/** The whole bear. Variants call this with hooks instead of copying drawing code. */
export function drawBear(ctx: Ctx2D, values: Params, t: number, rng: Rng, stage: Stage, kit: DrawKit, hooks: BearHooks = {}): void {
  const p = readParams(params, values);
  const ox = p.number('x');
  const oy = p.number('y') + breathOffset(p, t, rng);
  const b = bodyShape(p, stage, rng.fork('outline'), ox, oy);
  const face = expressive(p);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(degToRad(p.number('tilt')));

  kit.part('body', () => drawCast(ctx, b, p, rng.fork('cast')));
  kit.part('ears', () => drawEars(ctx, b, p, rng.fork('ears')));
  kit.part('body', () => drawBody(ctx, b, p, rng.fork('body')));
  hooks.head?.(ctx, b, t);

  const fx = p.number('faceX') * b.W;
  const fy = p.number('faceY') * b.W;
  const faceTilt = degToRad(p.number('faceTilt'));
  ctx.translate(fx, fy);
  ctx.rotate(faceTilt);
  kit.part('muzzle', () => drawMuzzle(ctx, b, p, rng.fork('muzzle')));
  kit.part('nose', () => drawNose(ctx, b, p, rng.fork('nose')));
  kit.part('mouth', () => drawMouth(ctx, b, face.p, rng.fork('mouth'), face.open));
  kit.part('eyes', () => drawEyes(ctx, b, face.p, rng.fork('eyes'), eyelids(p, t, rng)));
  kit.part('paws', () => {
    if (!(p.number('pawSize') * b.W >= 2)) return;
    // Paws sit in front of the face, placed in the body frame.
    ctx.save();
    ctx.rotate(-faceTilt);
    ctx.translate(-fx, -fy);
    drawPaws(ctx, pawBody(b), p, rng.fork('paws'), t);
    ctx.restore();
  });
  ctx.restore();
}

/** How far the breath lifts the bear at time t, in pixels (negative is up). */
function breathOffset(p: Reader, t: number, rng: Rng): number {
  const amount = p.number('breath');
  if (amount <= 0) return 0;
  return -amount * BREATH_LIFT * p.number('width') * breathCycle(rng.fork('breath'), t);
}

/** Eyelid closure at time t: the blink param, or 1 during an automatic blink. */
function eyelids(p: Reader, t: number, rng: Rng): number {
  return Math.max(p.number('blink'), blinkClosure(rng.fork('blink'), p.number('blinkRate'), t));
}

function pawBody(b: Body) {
  return { W: b.W, depth: (x: number, y: number) => depthAt(b, x, y), solid: b.outline, sides: (y: number) => sides(b, y) };
}

/* ------------------------------------------------------------------ expressions */

type Adjust = Partial<Record<string, (v: number) => number>>;

/**
 * Each expression moves face params from the values the bear already has, so
 * a bear's own brows, eyes and smile still show through. neutral moves nothing.
 */
const EXPRESSIONS: Record<BearExpression, { adjust: Adjust; open: number }> = {
  neutral: { adjust: {}, open: 0 },
  happy: {
    adjust: {
      browY: (v) => v - 0.014,
      browTilt: (v) => v - 12,
      smileDepth: (v) => v + 0.035,
      smileWidth: (v) => v * 1.15 + 0.02,
      eyeSize: (v) => v * 0.94,
      lookY: (v) => v - 0.2,
    },
    open: 0,
  },
  sad: {
    adjust: {
      browY: (v) => v + 0.004,
      browTilt: (v) => v + 20,
      smileDepth: (v) => -0.4 * v - 0.03,
      smileWidth: (v) => v * 0.8,
      eyeSize: (v) => v * 0.94,
      lookY: (v) => v + 0.9,
    },
    open: 0,
  },
  surprised: {
    adjust: {
      browY: (v) => v - 0.04,
      browTilt: (v) => v * 0.4,
      eyeSize: (v) => v * 1.3,
      smileWidth: () => 0,
      mouthDrop: (v) => v * 0.7,
      lookY: () => 0,
      lookX: (v) => v * 0.3,
    },
    open: 1,
  },
};

/** The face params with the expression applied (clamped to their ranges), and how open the mouth is. */
function expressive(p: Reader): { p: Reader; open: number } {
  const e = EXPRESSIONS[p.string('expression') as BearExpression] ?? EXPRESSIONS.neutral;
  const keys = Object.keys(e.adjust);
  if (keys.length === 0) return { p, open: e.open };
  const range = (key: string) => params[key] as { min: number; max: number };
  const number = (key: string): number => {
    const fn = e.adjust[key];
    if (!fn) return p.number(key);
    return clamp(fn(p.number(key)), range(key).min, range(key).max);
  };
  return {
    open: e.open,
    // integer() too, or it would read the unadjusted value through p's own number().
    p: {
      ...p,
      number,
      integer: (key) => (e.adjust[key] ? clamp(Math.round(number(key)), range(key).min, range(key).max) : p.integer(key)),
    },
  };
}

/* ------------------------------------------------------------------ body shape */

/**
 * The tombstone outline: straight flared sides, elliptical top corners and a
 * slightly domed top, built upright and then sheared so each side leans out
 * by its flare. The bottom edge sits bodyLength below the top, or just below
 * the stage when bodyLength is 0. (ox, oy) is the top centre in scene pixels.
 */
function bodyShape(p: Reader, stage: Stage, rng: Rng, ox: number, oy: number): Body {
  const W = p.number('width');
  const hw = W / 2;
  const tilt = degToRad(p.number('tilt'));
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const local = ([sx, sy]: Pt): Pt => [(sx - ox) * cos + (sy - oy) * sin, -(sx - ox) * sin + (sy - oy) * cos];
  const corners = ([[0, 0], [stage.width, 0], [0, stage.height], [stage.width, stage.height]] as Pt[]).map(local);
  const view: Bounds = {
    minX: Math.min(...corners.map((q) => q[0])),
    maxX: Math.max(...corners.map((q) => q[0])),
    minY: Math.min(...corners.map((q) => q[1])),
    maxY: Math.max(...corners.map((q) => q[1])),
  };
  const r = Math.min(p.number('corner') * W, hw * 0.98);
  const ryL0 = r * p.number('shoulderLeft');
  const ryR0 = r * p.number('shoulderRight');
  const length = p.number('bodyLength') * W;
  const fixed = length > 0;
  const L = Math.max(Math.max(ryL0, ryR0) + W * 0.3, fixed ? length : view.maxY + W * 0.08 + 12);
  const ryL = Math.min(ryL0, L * 0.9);
  const ryR = Math.min(ryR0, L * 0.9);
  const fl = p.number('flareLeft');
  const fr = p.number('flareRight');
  const dome = p.number('dome') * W;
  const topY = (x: number) => -dome * (1 - Math.min(1, (x / hw) ** 2));

  const raw: Pt[] = [[-hw, L], [-hw, ryL]];
  const cornerSteps = 14;
  for (let i = 1; i <= cornerSteps; i++) {
    const t = i / cornerSteps;
    const a = Math.PI + (t * Math.PI) / 2;
    const x = -hw + r + r * Math.cos(a);
    raw.push([x, ryL + ryL * Math.sin(a) + topY(x) * t]);
  }
  const topSteps = 12;
  for (let i = 1; i < topSteps; i++) {
    const x = lerp(-hw + r, hw - r, i / topSteps);
    raw.push([x, topY(x)]);
  }
  for (let i = 0; i < cornerSteps; i++) {
    const t = i / cornerSteps;
    const a = -Math.PI / 2 + (t * Math.PI) / 2;
    const x = hw - r + r * Math.cos(a);
    raw.push([x, ryR + ryR * Math.sin(a) + topY(x) * (1 - t)]);
  }
  raw.push([hw, ryR], [hw, L]);
  // Shear each half so its side leans out by its flare; blend across the middle so the top stays smooth.
  const sheared = raw.map(([x, y]): Pt => [x + shearAt(x, hw, fl, fr) * y, y]);

  const step = clamp(W / 60, 3, 40);
  const pts = resample(sheared, step);
  const rough = p.number('edgeRough');
  const bumpy = wobble(pts, rng, rough * W * 0.0035, Math.max(6, pts.length / 14));
  // Keep the off-stage bottom edge straight.
  const outline = bumpy.map((q, i): Pt => (pts[i][1] >= L - 1 ? pts[i] : q));
  const shape = { W, hw, fl, fr, r, ryL, ryR, dome, L };
  // What can be on stage (the stage-fitted layout of a still), or the whole body.
  const [left, right] = sides(shape, L);
  const whole: Bounds = { minX: Math.min(left, -hw), maxX: Math.max(right, hw), minY: -dome - 2, maxY: L };
  const box: Bounds = fixed
    ? whole
    : {
        minX: Math.max(view.minX, whole.minX),
        maxX: Math.min(view.maxX, whole.maxX),
        minY: Math.max(view.minY, whole.minY),
        maxY: Math.min(view.maxY, whole.maxY),
      };
  return {
    ...shape, fixed, view, box, outline,
    normals: outwardNormals(outline),
    toScene: (x, y) => [ox + x * cos - y * sin, oy + x * sin + y * cos],
    stage,
  };
}

function shearAt(x: number, hw: number, fl: number, fr: number): number {
  return lerp(-fl, fr, smoothstep(-hw * 0.3, hw * 0.3, x));
}

/** Local x of the left and right body edges at depth y, ignoring the top corners. */
function sides(b: Pick<Body, 'hw' | 'fl' | 'fr'>, y: number): [number, number] {
  return [-b.hw - b.fl * y, b.hw + b.fr * y];
}

/** Approximate distance inside the body at a body-frame point: positive inside, negative outside. */
function depthAt(b: Body, x: number, y: number): number {
  const xu = x - shearAt(x, b.hw, b.fl, b.fr) * y;
  const ax = Math.abs(xu);
  const ry = xu < 0 ? b.ryL : b.ryR;
  let d = Math.min(b.hw - ax, y + b.dome * (1 - Math.min(1, (xu / b.hw) ** 2)), b.L - y);
  if (ax > b.hw - b.r && y < ry) {
    const e = Math.hypot((ax - (b.hw - b.r)) / b.r, (y - ry) / ry);
    d = Math.min(d, (1 - e) * Math.min(b.r, ry));
  }
  return d;
}

/** Whether a body-frame point is on stage. A fixed body places marks everywhere, on stage or not. */
function inStage(b: Body, x: number, y: number): boolean {
  if (b.fixed) return true;
  const [sx, sy] = b.toScene(x, y);
  return sx >= 0 && sx <= b.stage.width && sy >= 0 && sy <= b.stage.height;
}

/** Body area where marks go, in square pixels, by Monte Carlo over b.box. */
function visibleArea(b: Body, rng: Rng): number {
  const box = b.box;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (!(w > 0 && h > 0)) return 0;
  let hits = 0;
  const tries = 240;
  for (let i = 0; i < tries; i++) {
    const x = rng.range(box.minX, box.maxX);
    const y = rng.range(box.minY, box.maxY);
    if (depthAt(b, x, y) > 0 && inStage(b, x, y)) hits++;
  }
  return (w * h * hits) / tries;
}

/** Unit direction of the body's grain at a point: straight down, leaning with the flare of the nearer side. */
function grainAt(b: Body, x: number, y: number, slant: number): Pt {
  const [l, r] = sides(b, Math.max(0, y));
  const u = clamp((x - l) / Math.max(1, r - l), 0, 1);
  const dx = lerp(-b.fl, b.fr, u) + slant;
  const len = Math.hypot(dx, 1);
  return [dx / len, 1 / len];
}

/* ------------------------------------------------------------------ cast shadow */

/**
 * The shadow this bear throws on the bear behind it: a band hugging each
 * chosen side that widens going down, with a darker blob under that side's
 * ear. Hard where it meets this bear (which covers it), soft and uneven on
 * the outer side. It multiplies, so it darkens whatever is behind.
 */
function drawCast(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const { W } = b;
  const top = p.number('castTop') * W;
  const bottom = p.number('castWidth') * W;
  const R = p.number('earSize') * W;
  const yEnd = b.fixed ? b.L : Math.min(b.L, b.view.maxY + W * 0.1);
  for (const side of [-1, 1]) {
    const strength = p.number(side < 0 ? 'castLeft' : 'castRight');
    const color = p.string(side < 0 ? 'castLeftColor' : 'castRightColor');
    if (strength <= 0 || (top <= 0 && bottom <= 0) || !paintable(color)) continue;
    const rs = rng.fork(side < 0 ? 'left' : 'right');
    const y0 = (side < 0 ? b.ryL : b.ryR) * 0.8;
    if (!(yEnd > y0 + 1)) continue;
    const wob = periodicNoise(rs, 3);
    const steps = 18;
    const outer: Pt[] = [];
    const inner: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = lerp(y0, yEnd, t);
      const [l, r] = sides(b, y);
      const edge = side < 0 ? l : r;
      const reach = lerp(top, bottom, smoothstep(0, 1, t)) * (1 + 0.15 * wob(t * 0.5));
      outer.push([edge + side * Math.max(1, reach), y]);
      inner.push([edge - side * W * 0.05, y]);
    }
    const band = washShape([...outer, ...inner.reverse()], (x, y) => {
      const [l, r] = sides(b, y);
      return (side < 0 ? l - x : x - r) > 2 ? 1 : 0;
    });
    const shapes: WashShape[] = [band];
    const ex = p.number(side < 0 ? 'earLeftX' : 'earRightX') * W;
    const ey = p.number(side < 0 ? 'earLeftY' : 'earRightY') * W;
    if (R > 1) shapes.push(washShape(eggPoints(ex + side * R * 0.35, ey + R * 1.7, R * 0.95, R * 1.25, {}, 28)));
    const layers = 6;
    wash(ctx, shapes, rs, {
      color, layers, alpha: 1 - (1 - 0.75 * strength) ** (1 / layers), spread: W * 0.03, bias: -0.3, waveLength: W,
      composite: 'multiply',
    });
  }
}

/* ------------------------------------------------------------------ ears */

interface Ear {
  x: number;
  y: number;
  side: number;
  outline: Pt[];
}

function earShapes(b: Body, p: Reader, rng: Rng): Ear[] {
  const R = p.number('earSize') * b.W;
  if (R < 0.5) return [];
  const lean = degToRad(p.number('earLean'));
  return [-1, 1].map((side) => {
    const key = side < 0 ? 'Left' : 'Right';
    const x = p.number(`ear${key}X`) * b.W;
    const y = p.number(`ear${key}Y`) * b.W;
    const aspect = p.number(`ear${key}Aspect`);
    const count = clamp(Math.round((TAU * R) / 5), 16, 90);
    const ring = eggPoints(x, y, R, R * aspect, { rotation: side * lean }, count);
    return { x, y, side, outline: wobble(ring, rng.fork(`shape${key}`), R * 0.04 * p.number('edgeRough'), 4) };
  });
}

function drawEars(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const ears = earShapes(b, p, rng);
  if (ears.length === 0) return;
  const R = p.number('earSize') * b.W;
  const body = p.string('body');
  const rough = p.number('edgeRough');
  const gaps = p.number('dryness');
  const brush = new Brush(b.view, b.fixed);
  for (const ear of ears) {
    const re = rng.fork(ear.side < 0 ? 'left' : 'right');
    fillPoly(ctx, ear.outline, body);
    const loop = [...ear.outline, ...ear.outline.slice(0, 3)];
    ragEdge(brush, re, loop, 0, loop.length - 1, rough * (0.6 + b.W * 0.003), gaps * 0.8, body);
    brush.flush(ctx);

    const inner = p.number('innerEarSize');
    const innerColor = p.string('innerEar');
    if (inner > 0 && paintable(innerColor)) {
      // A faint patch nudged toward the head, rubbed in with scribbled loops.
      const ir = R * inner;
      const ix = ear.x - ear.side * R * 0.06;
      const iy = ear.y + R * 0.05;
      ctx.save();
      ctx.beginPath();
      tracePoly(ctx, ear.outline);
      ctx.clip();
      const patch = washShape(wobble(eggPoints(ix, iy, ir, ir * 0.95, {}, 28), re, ir * 0.08, 3));
      wash(ctx, [patch], re, {
        color: mixColor(innerColor, body, 0.5), layers: 3, alpha: 0.2, spread: Math.max(0.5, ir * 0.12), bias: -0.4, waveLength: ir * 4,
      });
      const loops = Math.round(14 + ir * 0.8);
      const lw = Math.max(0.7, R * 0.028);
      scribble(brush, re, ix, iy, ir, ir, loops, innerColor, 0.7, lw, 0.3);
      scribble(brush, re, ix, iy, ir * 0.75, ir * 0.75, loops * 0.35, mixColor(innerColor, '#ffffff', 0.5), 0.55, lw * 0.8, 0.3);
      brush.flush(ctx);
      ctx.restore();
    }
    const rim = p.number('earRim');
    if (rim > 0) {
      brokenRim(ctx, washShape(ear.outline), re, {
        color: p.string('rimColor'), alpha: 0.3 + 0.6 * rim, width: Math.max(0.8, b.W * 0.004), inset: Math.max(1, R * 0.03),
        gaps: 0.25, passes: 2, composite: 'source-over',
      });
    }
  }
}

/* ------------------------------------------------------------------ body */

function drawBody(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const { W, outline, normals } = b;
  const body = p.string('body');
  const rough = p.number('edgeRough');
  const gaps = p.number('dryness');
  const brush = new Brush(b.view, b.fixed);

  // Opaque base. On a dry-brush fringe side the solid paint stops short of the edge,
  // and drawFringe fills that band with broken bristle lines.
  const insets = fringeInsets(b, p, rng.fork('fringe-reach'));
  const hasFringe = insets.some((d) => d > 0.5);
  const solid = hasFringe ? offsetPoly(outline, normals, (i) => -insets[i]) : outline;
  fillPoly(ctx, solid, body);
  if (hasFringe) drawFringe(ctx, brush, b, p, rng.fork('fringe'), insets);

  // A ragged bristle contour and a few flicks where the brush left the edge.
  const bottom = (i: number) => outline[i][1] >= b.L - 1 || insets[i] > 0.5;
  const reach = rough * (1 + W * 0.006);
  if (rough > 0) {
    const re = rng.fork('edge');
    let i = 1;
    while (i < outline.length - 2) {
      const run = Math.max(3, Math.round((W * re.range(0.12, 0.4)) / (W / 60)));
      const to = Math.min(outline.length - 2, i + run);
      const mid = Math.floor((i + to) / 2);
      if (!bottom(mid)) {
        const onSide = outline[mid][1] >= Math.max(b.ryL, b.ryR);
        ragEdge(brush, re, outline, Math.max(1, i - 2), to, reach * (onSide ? 0.85 : 0.35) * re.range(0.6, 1.3), gaps, body);
      }
      i = to;
    }
    edgeFlicks(brush, re, outline, normals, Math.min(300, Math.round((outline.length * rough) / 6)), (r) => {
      const j = r.int(1, outline.length - 1);
      return bottom(j) || !inStage(b, outline[j][0], outline[j][1]) ? -1 : j;
    }, { length: W * 0.07, reach, width: Math.max(0.6, Math.sqrt(W / 400)) * 1.4, color: body, gaps: gaps * 0.7 });
    brush.flush(ctx);
  }

  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, solid);
  ctx.clip();

  const area = visibleArea(b, rng.fork('area'));
  const clear = faceClearing(b, p);
  drawStreaks(ctx, brush, b, p, rng.fork('streaks'), area, clear);
  drawRim(ctx, b, p, rng.fork('rim'));
  drawPatch(ctx, brush, b, p, rng.fork('patch'));
  drawFaceShade(ctx, brush, b, p, rng.fork('shade'));
  drawScratches(ctx, b, p, rng.fork('scratches'), area, clear);
  ctx.restore();
}

/** 0.15 over the face, rising to 1 away from it: painters keep loose marks off the features. */
function faceClearing(b: Body, p: Reader): (x: number, y: number) => number {
  const { W } = b;
  const a = degToRad(p.number('faceTilt'));
  const mx = p.number('muzzleX') * W * 0.5;
  const my = p.number('muzzleY') * W * 0.5;
  const fx = p.number('faceX') * W + mx * Math.cos(a) - my * Math.sin(a);
  const fy = p.number('faceY') * W + mx * Math.sin(a) + my * Math.cos(a);
  const reach = Math.max(
    8,
    0.5 * Math.max(p.number('muzzleWidth') * W, p.number('muzzleHeight') * W, (p.number('eyeSpacing') + 4 * p.number('eyeSize')) * W),
  );
  return (x, y) => 0.15 + 0.85 * smoothstep(0.75, 1.5, Math.hypot(x - fx, y - fy) / reach);
}

/** Draws candidate points over the visible body and keeps each with probability weight(x, y, depth). */
function placeMarks(
  b: Body, rng: Rng, count: number, weight: (x: number, y: number, d: number) => number, place: (x: number, y: number, d: number) => void,
): void {
  const box = b.box;
  if (!(box.maxX > box.minX && box.maxY > box.minY) || count <= 0) return;
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 12; tries++) {
    const x = rng.range(box.minX, box.maxX);
    const y = rng.range(box.minY, box.maxY);
    const d = depthAt(b, x, y);
    if (d <= 1 || !inStage(b, x, y)) continue;
    if (rng.next() > weight(x, y, d)) continue;
    placed++;
    place(x, y, d);
  }
}

/** Where marks bunch: near the edges (more on markSide), in noise clusters, and low on the stage. */
function markWeight(b: Body, p: Reader, rng: Rng, clear: (x: number, y: number) => number, edgeReach: number) {
  const cluster = noise2(rng, b.W * 0.22);
  const side = p.number('markSide');
  return (x: number, y: number, d: number) => {
    const low = smoothstep(0.45, 1, b.fixed ? y / b.L : b.toScene(x, y)[1] / b.stage.height);
    const lean = 1 + side * (x < 0 ? -0.8 : 0.8);
    const edge = Math.exp(-d / edgeReach) * lean;
    return clamp((0.04 + 0.85 * edge + 0.6 * smoothstep(0.5, 0.85, cluster(x, y)) + 0.35 * low) * clear(x, y) * 0.7, 0, 1);
  };
}

/** Broad faint tonal strokes, then shorter dry-brush streaks bunched toward the edges. */
function drawStreaks(
  ctx: Ctx2D, brush: Brush, b: Body, p: Reader, rng: Rng, area: number, clear: (x: number, y: number) => number,
): void {
  const density = p.number('strokes');
  if (density <= 0 || area <= 0) return;
  const { W } = b;
  const body = p.string('body');
  const tonal = p.number('tonal');
  const gaps = p.number('dryness');
  const light = mixColor(body, '#ffffff', 0.08 + 0.22 * tonal);
  const dark = mixColor(body, p.string('shade'), 0.2 + 0.5 * tonal);
  const pale = mixColor(body, p.string('scratch'), 0.45);
  const units = area / 10000;

  const ra = rng.fork('tonal');
  const nA = Math.min(MAX_TONAL, Math.round(density * units * 0.5));
  placeMarks(b, ra, nA, () => 1, (x, y) => {
    bodyStroke(brush, ra, b, x, y, W * ra.range(0.25, 0.8), {
      width: W * ra.range(0.035, 0.09), bristles: ra.int(6, 10), color: ra.next() < 0.5 ? light : dark,
      alpha: tonal * ra.range(0.08, 0.2), gaps: gaps * 0.7,
    });
  });
  brush.flush(ctx);

  const rb = rng.fork('dry');
  const weight = markWeight(b, p, rb.fork('weight'), clear, W * 0.1);
  const nB = Math.min(MAX_STREAKS, Math.round(density * units * 1.6));
  placeMarks(b, rb, nB, weight, (x, y, d) => {
    const pick = rb.next();
    bodyStroke(brush, rb, b, x, y, W * rb.range(0.05, 0.28), {
      width: W * rb.range(0.012, 0.032), bristles: rb.int(3, 8),
      color: pick < 0.45 ? light : pick < 0.9 ? dark : pale,
      alpha: (0.3 + 0.7 * tonal) * rb.range(0.12, 0.38) * (0.6 + 0.4 * Math.exp(-d / (W * 0.15))),
      gaps,
    });
  });
  brush.flush(ctx);
}

interface BodyStrokeStyle {
  width: number;
  bristles: number;
  color: string;
  alpha: number;
  gaps: number;
}

/** A dry stroke centred on a body-frame point, running along the body grain. */
function bodyStroke(brush: Brush, rng: Rng, b: Body, x: number, y: number, len: number, s: BodyStrokeStyle): void {
  const [ux, uy] = grainAt(b, x, y, rng.range(-0.08, 0.08));
  const h = len / 2;
  const bend = rng.range(-0.07, 0.07) * len;
  const dir = rng.next() < 0.5 ? 1 : -1;
  dryStroke(brush, rng, {
    x0: x - ux * h * dir, y0: y - uy * h * dir, cx: x - uy * bend, cy: y + ux * bend, x1: x + ux * h * dir, y1: y + uy * h * dir,
    ...s,
  });
}

/**
 * Per outline point, how far short of the edge the solid paint stops for
 * the dry-brush fringe: up to `fringe` of 8 percent of width on the chosen
 * sides, varying along the edge and easing in below the top corners, and 0
 * elsewhere.
 */
function fringeInsets(b: Body, p: Reader, rng: Rng): number[] {
  const band = b.W * 0.08 * p.number('fringe');
  const want = p.number('fringeSide');
  // The solid paint comes close to the edge in places and stops well short in others.
  const reach = periodicNoise(rng, Math.max(3, b.outline.length / 40));
  const n = b.outline.length;
  return b.outline.map(([x, y], i) => {
    const side = x < 0 ? -1 : 1;
    if (band <= 0 || y >= b.L - 1 || (want !== 0 && Math.sign(want) !== side)) return 0;
    const ry = side < 0 ? b.ryL : b.ryR;
    return band * smoothstep(ry * 0.3, ry * 0.8 + b.W * 0.1, y) * (0.55 + 0.45 * reach(i / n));
  });
}

/**
 * Dry-brush fringe: the band between the solid paint and the edge is filled
 * with long broken bristle lines that follow the outline, a few of them a
 * little darker than the body. Whatever lies underneath (the ground or the
 * bear behind) shows through the gaps, as when a dry brush is dragged along
 * an edge.
 */
function drawFringe(ctx: Ctx2D, brush: Brush, b: Body, p: Reader, rng: Rng, insets: readonly number[]): void {
  const { W, outline, normals } = b;
  const body = p.string('body');
  const dark = mixColor(body, p.string('shade'), 0.45);
  const wide = Math.max(0.8, Math.sqrt(W / 400));
  // Runs of consecutive fringe points that are on stage.
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    if (insets[i] > 0.5 && inStage(b, outline[i][0], outline[i][1])) run.push(i);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  for (const side of runs) {
    if (side.length < 4) continue;
    const count = Math.min(120, Math.round(side.length * 0.45));
    for (let k = 0; k < count; k++) {
      const len = Math.max(4, Math.round(side.length * rng.range(0.2, 0.6)));
      const from = rng.int(0, Math.max(1, side.length - 3));
      // Depth across the band as a fraction of it: most lines sit toward the solid paint.
      const f = rng.range(0.05, 1.1);
      const isDark = rng.next() < 0.3;
      const width = wide * (isDark ? rng.range(0.8, 1.8) : rng.range(2, 6));
      const alpha = isDark ? rng.range(0.5, 0.9) : 1;
      const drift = rng.range(-0.15, 0.15);
      let pts: number[] = [];
      let on = true;
      let left = rng.int(12, 60);
      const end = Math.min(side.length, from + len);
      for (let q = from; q < end; q++) {
        const i = side[q];
        const d = insets[i] * Math.max(0, f + drift * ((q - from) / len));
        if (on) pts.push(outline[i][0] - normals[i][0] * d, outline[i][1] - normals[i][1] * d);
        if (--left <= 0) {
          if (on) {
            brush.line(isDark ? dark : body, alpha, width, 'source-over', pts);
            pts = [];
          }
          on = !on;
          left = on ? rng.int(12, 60) : rng.int(2, 8);
        }
      }
      brush.line(isDark ? dark : body, alpha, width, 'source-over', pts);
    }
  }
  brush.flush(ctx);
}

/** Thin darker line just inside the top of the head, where paint gathered at the edge of the stroke. */
function drawRim(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const rim = p.number('rim');
  if (rim <= 0) return;
  const yMax = Math.max(b.ryL, b.ryR) + b.W * 0.12;
  brokenRim(ctx, washShape(b.outline), rng, {
    color: p.string('rimColor'), alpha: 0.25 + 0.5 * rim, width: Math.max(0.8, b.W * 0.004), inset: Math.max(1.2, b.W * 0.004),
    gaps: 0.3, passes: 2, composite: 'source-over', where: (_x, y) => y < yMax,
  });
}

/** A soft shade patch on the body: a few washed layers plus loose scribbled arcs. */
function drawPatch(ctx: Ctx2D, brush: Brush, b: Body, p: Reader, rng: Rng): void {
  const amount = p.number('patch');
  const color = p.string('patchColor');
  const rx = (p.number('patchWidth') * b.W) / 2;
  const ry = (p.number('patchHeight') * b.W) / 2;
  if (amount <= 0 || rx < 1 || ry < 1 || !paintable(color)) return;
  const cx = p.number('patchX') * b.W;
  const cy = p.number('patchY') * b.W;
  const shape = washShape(wobble(eggPoints(cx, cy, rx, ry, { taper: 0.1 }, 32), rng, Math.min(rx, ry) * 0.12, 3));
  const layers = 4;
  wash(ctx, [shape], rng, {
    color, layers, alpha: 1 - (1 - 0.6 * amount) ** (1 / layers), spread: Math.min(rx, ry) * 0.3, bias: -0.5, waveLength: rx * 4,
  });
  const loops = Math.min(80, 10 + (rx * ry) / 120);
  scribble(brush, rng, cx, cy, rx * 0.95, ry * 0.95, loops, mixColor(color, '#6f7896', 0.25), 0.5 * amount, Math.max(0.7, b.W * 0.0028), 0.45);
  brush.flush(ctx);
}

/**
 * Nose-bridge wedge and chin shadow, in the face frame. The bridge is a
 * flat, fairly crisp wedge from a rounded top down to the nose. The chin
 * shadow is a soft wash below the muzzle, crisp where the muzzle meets it
 * and brushed out on the far side.
 */
function drawFaceShade(ctx: Ctx2D, brush: Brush, b: Body, p: Reader, rng: Rng): void {
  const { W } = b;
  const shade = p.string('shade');
  if (!paintable(shade)) return;
  const bridge = p.number('bridge');
  const chin = p.number('chin');
  if (bridge <= 0 && chin <= 0) return;
  ctx.save();
  ctx.translate(p.number('faceX') * W, p.number('faceY') * W);
  ctx.rotate(degToRad(p.number('faceTilt')));
  const faceBrush = new Brush({ minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });

  const nw = (p.number('noseWidth') * W) / 2;
  const nh = (p.number('noseHeight') * W) / 2;
  const top = p.number('bridgeTop') * W;
  const capR = (p.number('bridgeWidth') * W) / 2;
  if (bridge > 0 && top > 1 && capR > 0.5) {
    const rb = rng.fork('bridge');
    // Rounded top, then sides that flare out toward the nose.
    const base = Math.max(capR * 1.2, nw * 0.85);
    const capY = -top + capR;
    const bottomY = nh * 0.2;
    const side = (t: number): [number, number] => [capR + (base - capR) * t ** 1.6, lerp(capY, bottomY, t)];
    const pts: Pt[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI + (i / 10) * Math.PI;
      pts.push([Math.cos(a) * capR, capY + Math.sin(a) * capR]);
    }
    for (let i = 1; i <= 6; i++) {
      const [x, y] = side(i / 6);
      pts.push([x, y]);
    }
    for (let i = 6; i >= 1; i--) {
      const [x, y] = side(i / 6);
      pts.push([-x, y]);
    }
    const wedge = wobble(resample(pts, Math.max(2, capR / 4)), rb, Math.max(0.5, W * 0.003), 5);
    const shape = washShape(wedge);
    wash(ctx, [shape], rb, { color: shade, layers: 2, alpha: 1 - (1 - 0.92 * bridge) ** 0.5, spread: Math.max(0.6, W * 0.003), jitter: 0.4 });
    // A few body-colour and shade strokes inside so the wedge is brushed, not printed.
    ctx.save();
    ctx.beginPath();
    tracePoly(ctx, wedge);
    ctx.clip();
    const body = p.string('body');
    const n = Math.min(40, Math.round(8 + (top * base) / (W * W * 0.004)));
    for (let i = 0; i < n; i++) {
      const x = rb.range(-base, base);
      const y = rb.range(-top, bottomY);
      const len = W * rb.range(0.05, 0.14);
      dryStroke(faceBrush, rb, {
        x0: x, y0: y - len / 2, cx: x + rb.range(-0.05, 0.05) * len, cy: y, x1: x + rb.range(-0.12, 0.12) * len, y1: y + len / 2,
        width: W * rb.range(0.012, 0.03), bristles: rb.int(2, 5), color: rb.next() < 0.5 ? shade : body,
        alpha: bridge * rb.range(0.1, 0.25), gaps: p.number('dryness'),
      });
    }
    faceBrush.flush(ctx);
    ctx.restore();
  }

  const mw = (p.number('muzzleWidth') * W) / 2;
  const mh = (p.number('muzzleHeight') * W) / 2;
  const size = p.number('chinSize');
  if (chin > 0 && mw > 1 && mh > 1 && size > 0) {
    const rc = rng.fork('chin');
    const mx = p.number('muzzleX') * W;
    const my = p.number('muzzleY') * W;
    const cx = mx + p.number('chinX') * W;
    const cy = my + p.number('chinY') * W;
    const ring = wobble(eggPoints(cx, cy, mw * size, mh * size, muzzleShape(p, 0.5), 40), rc, W * 0.006, 4);
    // Soft where the shadow faces away from the muzzle, crisp where it tucks under it.
    const shape = washShape(ring, (x, y) => {
      const ox = x - mx;
      const oy = y - my;
      const out = ((x - cx) * ox + (y - cy) * oy) / (Math.hypot(x - cx, y - cy) * Math.hypot(ox, oy) || 1);
      return 0.25 + 1.1 * smoothstep(-0.2, 0.8, out);
    });
    const layers = 5;
    wash(ctx, [shape], rc, {
      color: shade, layers, alpha: 1 - (1 - 0.9 * chin) ** (1 / layers), spread: W * 0.012, bias: -0.35, waveLength: mw * 3,
    });
  }
  ctx.restore();
}

/**
 * Sgraffito-like scratches: thin tapered light marks in loose groups of 1 to
 * 5 near-parallel lines, bunched near the edges, in clusters and low on the
 * body, and kept off the face. Three pale tints of the body colour, one fill each.
 */
function drawScratches(ctx: Ctx2D, b: Body, p: Reader, rng: Rng, area: number, clear: (x: number, y: number) => number): void {
  const amount = p.number('scratches');
  const scratch = p.string('scratch');
  if (amount <= 0 || area <= 0 || !paintable(scratch)) return;
  const { W } = b;
  const body = p.string('body');
  const tones = [mixColor(body, scratch, 0.45), mixColor(body, scratch, 0.7), mixColor(body, scratch, 0.95)];
  const marks = new Marks(b.view, b.fixed);
  const weight = markWeight(b, p, rng.fork('weight'), clear, W * 0.2);
  const groups = Math.min(MAX_SCRATCH_GROUPS, Math.round((amount * area) / 4000));
  const thin = Math.max(0.5, Math.sqrt(W / 400) * 1.1 * p.number('scratchWidth'));
  placeMarks(b, rng, groups, weight, (x, y) => {
    // A few groups are a spray of tiny flecks where the brush spattered.
    if (rng.next() < 0.15) {
      const n = rng.int(3, 9);
      for (let k = 0; k < n; k++) {
        const fx = x + rng.range(-1, 1) * W * 0.03;
        const fy = y + rng.range(-1, 1) * W * 0.05;
        if (depthAt(b, fx, fy) <= 2) continue;
        const [dx, dy] = grainAt(b, fx, fy, rng.range(-0.3, 0.3));
        const len = thin * rng.range(1.5, 5);
        marks.spindle(tones[rng.int(1, 3)], 1, fx, fy, fx + dx * len * 0.5, fy + dy * len * 0.5, fx + dx * len, fy + dy * len, thin * rng.range(0.8, 1.5), 0.5);
      }
      return;
    }
    const lines = rng.int(1, 4);
    const slant = rng.range(-0.2, 0.05);
    const baseLen = W * Math.exp(rng.range(Math.log(0.03), Math.log(0.2)));
    let ox = 0;
    let oy = 0;
    for (let k = 0; k < lines; k++) {
      const x0 = x + ox;
      const y0 = y + oy;
      if (depthAt(b, x0, y0) <= 2) break;
      const [dx, dy] = grainAt(b, x0, y0, slant + rng.range(-0.04, 0.04));
      const len = baseLen * rng.range(0.5, 1.1);
      const bow = rng.range(-0.025, 0.025) * len;
      const tone = Math.min(2, Math.floor(rng.next() * 3 * (k === 0 ? 1 : 0.75)));
      marks.spindle(
        tones[tone], 1,
        x0, y0, x0 + dx * len * 0.5 - dy * bow, y0 + dy * len * 0.5 + dx * bow, x0 + dx * len, y0 + dy * len,
        thin * rng.range(0.7, 1.6), rng.range(0.2, 0.5),
      );
      // The next line of the group sits a few pixels to the side, a little up or down the body.
      const step = rng.range(3, 11) * (W / 400) ** 0.5;
      ox += -dy * step + dx * rng.range(-0.35, 0.35) * len;
      oy += dx * step + dy * rng.range(-0.35, 0.35) * len;
    }
  });
  marks.flush(ctx);
}

/* ------------------------------------------------------------------ face */

/**
 * The muzzle's egg: narrower at the top by muzzleTaper, with its widest point
 * pushed down by the same amount so the mass sits low like a real snout.
 * `k` scales the taper (the chin shadow uses a softer copy).
 */
function muzzleShape(p: Reader, k: number): EggShape {
  const taper = p.number('muzzleTaper') * k;
  return { taper, squareness: p.number('muzzleSquare'), lift: -0.9 * taper };
}

/**
 * Muzzle: a chalky egg narrowing toward the bridge, with a ragged rim, then
 * strokes worked down its meridians: cool ones pressing harder toward the
 * rim, the chin and the shaded side, chalky light ones inside.
 */
function drawMuzzle(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const { W } = b;
  const color = p.string('muzzle');
  const rx = (p.number('muzzleWidth') * W) / 2;
  const ry = (p.number('muzzleHeight') * W) / 2;
  if (rx < 0.5 || ry < 0.5 || !paintable(color)) return;
  const cx = p.number('muzzleX') * W;
  const cy = p.number('muzzleY') * W;
  const rough = p.number('edgeRough');
  const gaps = p.number('dryness');
  const count = clamp(Math.round((rx + ry) / 2.5), 24, 120);
  const rim = wobble(eggPoints(cx, cy, rx, ry, muzzleShape(p, 1), count), rng.fork('shape'), W * 0.004 * rough, 5);
  const brush = new Brush(EVERYWHERE);
  fillPoly(ctx, rim, color);
  const loop = [...rim, ...rim.slice(0, 3)];
  ragEdge(brush, rng, loop, 0, loop.length - 1, rough * (0.6 + W * 0.003), gaps * 0.8, color);
  brush.flush(ctx);

  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, rim);
  ctx.clip();
  const cool = p.string('muzzleShade');
  const chalk = mixColor(color, '#ffffff', 0.7);
  const side = p.number('shadeSide');
  const normals = outwardNormals(rim);
  const thin = Math.max(0.7, W * 0.0042);

  // Cool strokes worked round the rim, crowding the shaded side and the chin.
  const nCool = Math.min(70, Math.round((rx + ry) / 5));
  for (let i = 0; i < nCool; i++) {
    const start = rng.int(0, rim.length);
    const [sx, sy] = rim[start];
    const facing = clamp(((sx - cx) / rx) * side, 0, 1) + clamp((sy - cy) / ry, 0, 1) * 0.6;
    if (rng.next() > 0.25 + 0.75 * facing) continue;
    const run = Math.max(3, Math.round(rim.length * rng.range(0.04, 0.14)));
    const inset = thin + rx * 0.2 * rng.next() ** 2;
    const pts: number[] = [];
    for (let k = 0; k <= run; k++) {
      const j = (start + k) % rim.length;
      const drift = inset * (1 + 0.3 * Math.sin((k / run) * Math.PI));
      pts.push(rim[j][0] - normals[j][0] * drift, rim[j][1] - normals[j][1] * drift);
    }
    brush.line(cool, rng.range(0.25, 0.6) * (0.5 + 0.5 * facing), thin * rng.range(0.8, 1.8), 'source-over', pts);
  }
  // Chalky light strokes scumbled over the middle: short, thin, loosely following the form.
  const span = spanAt(eggPoints(cx, cy, rx, ry, muzzleShape(p, 1), 48));
  const nChalk = Math.min(90, Math.round((rx + ry) / 3.5));
  for (let i = 0; i < nChalk; i++) {
    const u = rng.range(-0.85, 0.85);
    const len = ry * rng.range(0.08, 0.32);
    const y0 = cy + rng.range(-ry * 0.85, ry * 0.9 - len);
    const y1 = y0 + len;
    const at = (y: number) => {
      const [l, r] = span(y);
      return lerp((l + r) / 2, u < 0 ? l : r, Math.abs(u) * 0.95);
    };
    const lean = rng.range(-0.35, 0.35) * len;
    dryStroke(brush, rng, {
      x0: at(y0) - lean / 2, y0, cx: at((y0 + y1) / 2) + rng.range(-1, 1) * thin * 2, cy: (y0 + y1) / 2, x1: at(y1) + lean / 2, y1,
      width: thin * rng.range(1, 2.4), bristles: rng.int(1, 3), color: chalk, alpha: rng.range(0.2, 0.5), gaps,
    });
  }
  brush.flush(ctx);
  ctx.restore();
}

/** For a closed outline, a function giving the left and right x where a horizontal line at y crosses it. */
function spanAt(pts: readonly Pt[]): (y: number) => [number, number] {
  let cxSum = 0;
  for (const q of pts) cxSum += q[0];
  const mid = cxSum / Math.max(1, pts.length);
  return (y) => {
    let l = Infinity;
    let r = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y) === (y1 <= y)) continue;
      const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
      l = Math.min(l, x);
      r = Math.max(r, x);
    }
    return Number.isFinite(l) ? [l, r] : [mid, mid];
  };
}

/**
 * Nose: a bulbous black egg with a rough rim, faint lighter-black strokes
 * just inside the rim for a waxy sheen, and a chunky white highlight streak
 * plus a small dab along the top.
 */
function drawNose(ctx: Ctx2D, b: Body, p: Reader, rng: Rng): void {
  const { W } = b;
  const ink = p.string('ink');
  const rx = (p.number('noseWidth') * W) / 2;
  const ry = (p.number('noseHeight') * W) / 2;
  if (rx < 0.5 || ry < 0.5 || !paintable(ink)) return;
  const rough = p.number('edgeRough');
  const count = clamp(Math.round((rx + ry) / 2), 24, 100);
  const taper = p.number('noseTaper');
  const shape = { taper, squareness: 3.2, lift: -0.5 * taper };
  const rim = wobble(eggPoints(0, 0, rx, ry, shape, count), rng.fork('shape'), W * 0.003 * rough, 6);
  const brush = new Brush(EVERYWHERE);
  fillPoly(ctx, rim, ink);
  const loop = [...rim, ...rim.slice(0, 3)];
  ragEdge(brush, rng, loop, 0, loop.length - 1, rough * (0.4 + W * 0.002), 0.6, ink);
  brush.flush(ctx);

  // Waxy sheen: faint broken strokes of a lighter black following the lower rim, just inside it.
  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, rim);
  ctx.clip();
  brokenRim(ctx, washShape(rim), rng, {
    color: mixColor(ink, '#9aa0b8', 0.25), alpha: 0.3, width: Math.max(0.7, ry * 0.045), inset: Math.max(1.5, ry * 0.1),
    gaps: 0.5, passes: 2, composite: 'source-over', where: (_x, y) => y > -ry * 0.2,
  });
  ctx.restore();

  // Highlight: a chunky white streak across the top, heavier at the left, with a rough second pass and a dab after it.
  const g = p.number('glint');
  if (g <= 0) return;
  const marks = new Marks(EVERYWHERE);
  const hw = Math.max(1, ry * 0.24 * (0.5 + 0.5 * g));
  const x0 = -rx * (0.3 + 0.35 * g);
  const x1 = rx * 0.45 * g;
  const yEnd = -ry * 0.56;
  marks.spindle(HIGHLIGHT, 1, x0, yEnd + ry * 0.04, (x0 + x1) / 2, -ry * 0.8, x1, yEnd, hw, 0.3);
  const pts: number[] = [];
  const widths: number[] = [];
  const bumps = periodicNoise(rng, 3);
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    pts.push(lerp(x0, x1, u) + rx * 0.02, yEnd - ry * 0.12 * Math.sin(Math.PI * u) + ry * 0.03 * bumps(u));
    widths.push(hw * 0.6 * (0.7 + 0.5 * bumps(u + 0.3)) * Math.sin(Math.PI * clamp(u * 1.15, 0, 1)) ** 0.5);
  }
  marks.ribbon(HIGHLIGHT, 0.8, pts, widths);
  if (g > 0.3) marks.spindle(HIGHLIGHT, 1, x1 + rx * 0.08, yEnd + ry * 0.02, x1 + rx * 0.14, yEnd - ry * 0.02, x1 + rx * 0.2, yEnd + ry * 0.05, hw * 0.8, 0.5);
  marks.flush(ctx);
}

/** A wobbly brush line through three points with pressure that swells and fades, drawn twice with a small offset. */
function inkLine(
  marks: Marks, rng: Rng, color: string, width: number,
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, endScale: number,
): void {
  if (!(width > 0.2)) return;
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(cx - x0, cy - y0);
  const steps = clamp(Math.round(len / 3), 6, 30);
  const wob = periodicNoise(rng, 2);
  const press = periodicNoise(rng, 2);
  for (let pass = 0; pass < 2; pass++) {
    const shift = pass === 0 ? 0 : width * 0.25;
    const scale = pass === 0 ? 1 : 0.7;
    const base = quadPoints(x0, y0, cx + rng.range(-1, 1) * width * 0.3, cy + rng.range(-1, 1) * width * 0.3, x1, y1, steps);
    const pts: number[] = [];
    const widths: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const a = Math.max(0, i - 1);
      const c = Math.min(steps, i + 1);
      const tx = base[2 * c] - base[2 * a];
      const ty = base[2 * c + 1] - base[2 * a + 1];
      const tl = Math.hypot(tx, ty) || 1;
      const off = width * 0.35 * wob(u * 0.5 + pass * 0.25) + shift;
      pts.push(base[2 * i] - (ty / tl) * off, base[2 * i + 1] + (tx / tl) * off);
      const swell = endScale + (1 - endScale) * Math.sin(Math.PI * u) ** 0.6;
      widths.push(width * scale * swell * (0.85 + 0.3 * press(u * 0.5 + pass * 0.5)));
    }
    marks.ribbon(color, pass === 0 ? 1 : 0.85, pts, widths);
  }
}

/**
 * Mouth: a line dropping from the nose into a small smile. With `open` above
 * 0 (the surprised expression) a small open mouth hangs from the end of the
 * line instead of, or as well as, the smile.
 */
function drawMouth(ctx: Ctx2D, b: Body, p: Reader, rng: Rng, open: number): void {
  const { W } = b;
  const ink = p.string('ink');
  if (!paintable(ink)) return;
  const lw = p.number('lineWeight') * W;
  const nh = p.number('noseHeight') * W;
  const top = nh * 0.4;
  const bottom = nh / 2 + p.number('mouthDrop') * W;
  const mx = p.number('mouthX') * W;
  const sw = (p.number('smileWidth') * W) / 2;
  const sd = p.number('smileDepth') * W;
  const marks = new Marks(EVERYWHERE);
  if (bottom - top > 1) {
    inkLine(marks, rng, ink, lw, 0, top, mx * 0.4 + rng.range(-0.02, 0.02) * (bottom - top), (top + bottom) / 2, mx, bottom, 0.6);
  }
  if (sw > 0.5) {
    inkLine(marks, rng, ink, lw, mx - sw, bottom - sd, mx + rng.range(-0.1, 0.1) * sw, bottom + sd, mx + sw, bottom - sd * 0.9, 0.35);
  }
  marks.flush(ctx);
  if (open > 0) drawOpenMouth(ctx, W, p, rng.fork('open'), mx, bottom, open);
}

/**
 * A small open mouth: a dark egg, deeper red inside, with a ragged painted
 * rim and a paler tongue at the bottom. Its top sits at (x, y).
 */
function drawOpenMouth(ctx: Ctx2D, W: number, p: Reader, rng: Rng, x: number, y: number, open: number): void {
  const ink = p.string('ink');
  const rx = W * 0.034 * open;
  const ry = W * 0.044 * open;
  if (rx < 0.5) return;
  const cy = y + ry * 0.85;
  const rim = wobble(eggPoints(x, cy, rx, ry, { taper: -0.15, lift: 0.1 }, 30), rng.fork('shape'), rx * 0.08, 3);
  const inside = mixColor(ink, '#8a1f14', 0.45);
  const brush = new Brush(EVERYWHERE);
  fillPoly(ctx, rim, inside);
  ctx.save();
  ctx.beginPath();
  tracePoly(ctx, rim);
  ctx.clip();
  const tongue = washShape(wobble(eggPoints(x + rx * 0.1, cy + ry * 0.75, rx * 0.8, ry * 0.5, {}, 20), rng.fork('tongue'), rx * 0.06, 2));
  wash(ctx, [tongue], rng.fork('tongue-wash'), { color: mixColor('#d9574a', ink, 0.15), layers: 2, alpha: 0.7, spread: Math.max(0.5, rx * 0.08) });
  ctx.restore();
  const loop = [...rim, ...rim.slice(0, 3)];
  ragEdge(brush, rng.fork('edge'), loop, 0, loop.length - 1, Math.max(0.5, p.number('lineWeight') * W * 0.45), 0.3, ink);
  brush.flush(ctx);
}

/** Eyes: black dots, or small whites with a pupil looking aside, each under a short brow dash. */
function drawEyes(ctx: Ctx2D, b: Body, p: Reader, rng: Rng, closure: number): void {
  const { W } = b;
  const ink = p.string('ink');
  const pr = p.number('eyeSize') * W;
  const whiteR = p.number('eyeWhite') * pr;
  const half = (p.number('eyeSpacing') * W) / 2;
  const ex0 = p.number('eyeX') * W;
  const ey = p.number('eyeY') * W;
  const browHalf = (p.number('browLength') * W) / 2;
  const tiltB = degToRad(p.number('browTilt'));
  const lw = p.number('lineWeight') * W * 1.6;
  const shut = closure >= SHUT;
  // A lowered lid squashes the eye from the top down; 1 when open.
  const squash = closure > 0 ? 1 - closure : 1;
  const marks = new Marks(EVERYWHERE);
  for (const side of [-1, 1]) {
    const re = rng.fork(side < 0 ? 'left' : 'right');
    const ex = ex0 + side * half;
    // The eye shapes are always built, so the brow below draws the same whether the eye is open or shut.
    let white: Pt[] | null = null;
    let px = ex;
    let py = ey;
    const hasWhite = whiteR > pr * 1.05;
    if (hasWhite) {
      const wy = whiteR * 0.86 * squash;
      white = wobble(eggPoints(ex, ey + whiteR * 0.86 * (1 - squash), whiteR, wy, {}, 28), re, whiteR * 0.06, 3);
      px = ex + p.number('lookX') * (whiteR - pr * 0.95);
      py = ey + whiteR * 0.86 * (1 - squash) + p.number('lookY') * (wy - pr * 0.9);
    }
    const pupil = wobble(eggPoints(px, py + (hasWhite ? 0 : pr * 1.05 * (1 - squash)), pr, pr * 1.05 * squash, {}, 22), re, pr * 0.08, 3);
    if (shut) {
      if (paintable(ink)) {
        // A shut eye: a short ink line curving down, where the lid meets the lashes.
        const span = hasWhite ? whiteR * 0.95 : pr * 1.7;
        const y = ey + (hasWhite ? whiteR * 0.35 : pr * 0.4);
        const rl = re.fork('lid');
        inkLine(marks, rl, ink, lw * 0.75, ex - span, y, ex + rl.range(-0.1, 0.1) * span, y + span * 0.55, ex + span, y - span * 0.05, 0.45);
      }
    } else if (closure > 0) {
      // Part way shut: the squashed eye, pupil kept inside the white.
      if (white) {
        fillPoly(ctx, white, EYE_WHITE);
        ctx.save();
        ctx.beginPath();
        tracePoly(ctx, white);
        ctx.clip();
        if (paintable(ink)) fillPoly(ctx, pupil, ink);
        ctx.restore();
      } else if (paintable(ink)) {
        fillPoly(ctx, pupil, ink);
      }
    } else {
      if (white) fillPoly(ctx, white, EYE_WHITE);
      if (paintable(ink)) fillPoly(ctx, pupil, ink);
    }
    if (browHalf > 0.5 && paintable(ink)) {
      // Inner end is the one nearer the nose; a positive tilt raises it.
      const bx = ex + side * p.number('browOut') * W;
      const by = ey + p.number('browY') * W;
      const a = side * tiltB;
      const dx = Math.cos(a) * browHalf;
      const dy = Math.sin(a) * browHalf;
      inkLine(marks, re, ink, lw, bx - dx, by - dy, bx + re.range(-0.1, 0.1) * browHalf, by - browHalf * 0.22, bx + dx, by + dy, 0.35);
    }
  }
  marks.flush(ctx);
}
