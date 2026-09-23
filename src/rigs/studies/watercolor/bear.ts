/** PROTOTYPE watercolour study: a tombstone-shaped bear built from layered transparent washes on reserved paper. */
import type { Ctx2D, ParamSchema, Rig, Rng, Stage } from '../../../engine/types';
import { clamp, degToRad } from '../../parts/math';
import { readParams } from '../../parts/params';
import {
  bloomRing,
  blooms,
  fleckPath,
  scribblePath,
  withSoftness,
  thin,
  circlePoints,
  fray,
  gauss,
  mix,
  offsetRing,
  paintable,
  pool,
  ringFrom,
  specks,
  streakPath,
  taperedStroke,
  traceRing,
  TAU,
  valueNoise,
  wash,
  type Box,
  type Pt,
  type Ring,
} from './wash';

const num = (d: number, min: number, max: number, description: string) =>
  ({ type: 'number', default: d, min, max, description }) as const;
const col = (d: string, description: string) => ({ type: 'color', default: d, description }) as const;

const params: ParamSchema = {
  x: num(540, -3000, 6000, 'Centre line of the head (midway between the ears), scene px.'),
  y: num(700, -3000, 6000, 'Top of the head at the shoulders, scene px. The body hangs down from here.'),
  scale: num(1, 0.25, 4, 'Uniform scale of the whole bear about (x, y).'),
  tilt: num(0, -45, 45, 'Tilt of the head and body in degrees, clockwise on screen, about (x, y).'),
  bodyLeft: num(190, 40, 1200, 'Distance from the centre line to the left side at the shoulders, px.'),
  bodyRight: num(190, 40, 1200, 'Distance from the centre line to the right side at the shoulders, px.'),
  flareLeft: num(0.15, -0.5, 1.5, 'How far the left side leans outward per px of drop. 0 is vertical.'),
  flareRight: num(0.15, -0.5, 1.5, 'How far the right side leans outward per px of drop. 0 is vertical.'),
  bulgeLeft: num(0, -300, 300, 'Extra outward bow of the left side, built up over the top 180 px. Negative bows it in.'),
  bulgeRight: num(0, -300, 300, 'Extra outward bow of the right side, built up over the top 180 px. Negative bows it in.'),
  shoulder: num(0.45, 0.05, 1, 'Rounding of the top corners, as a fraction of the narrower half-width.'),
  dome: num(6, 0, 200, 'How far the top edge arches up between the corners, px.'),
  length: num(0, 0, 5000, 'Body length below the top, px. 0 runs the body past the bottom of the stage.'),
  earSpread: num(180, 0, 1200, 'Distance from the centre line to each ear centre, px.'),
  earY: num(0, -400, 400, 'Ear centre height relative to the top of the head, px. Negative is higher.'),
  earSize: num(55, 0, 400, 'Ear radius, px. 0 hides the ears.'),
  faceX: num(0, -600, 600, 'Sideways offset of the whole face from the centre line, px.'),
  eyeY: num(115, -200, 1200, 'Eye line below the top of the head, px.'),
  eyeSpacing: num(100, 0, 600, 'Half the distance between the eyes, px.'),
  eyeSize: num(9, 0, 80, 'Pupil radius, px.'),
  sclera: num(0, 0, 1, 'Size of the white around each pupil. 0 shows the pupil alone.'),
  lookX: num(0, -1, 1, 'Where the pupils look sideways inside the whites, -1 left to 1 right.'),
  lookY: num(0, -1, 1, 'Where the pupils look vertically inside the whites, -1 up to 1 down.'),
  browLift: num(38, 0, 300, 'Height of the brow dashes above the eyes, px.'),
  browTilt: num(12, -45, 45, 'Degrees the inner ends of the brows rise. Negative gives a frown.'),
  noseY: num(190, -200, 1500, 'Nose centre below the top of the head, px.'),
  noseWidth: num(170, 0, 800, 'Nose width, px.'),
  noseHeight: num(120, 0, 600, 'Nose height, px.'),
  muzzleY: num(250, -200, 1500, 'Muzzle centre below the top of the head, px.'),
  muzzleWidth: num(210, 0, 1000, 'Muzzle width, px.'),
  muzzleHeight: num(320, 0, 1200, 'Muzzle height, px.'),
  mouthDrop: num(90, 0, 600, 'Length of the line from the bottom of the nose down to the smile, px.'),
  smileWidth: num(95, 0, 600, 'Width of the smile curve, px.'),
  bridge: num(0.6, 0, 1, 'Strength of the darker glaze on the snout bridge above the nose.'),
  chin: num(0.6, 0, 1, 'Strength of the darker glaze under the muzzle.'),
  shadeSide: num(0, -1, 1, 'Darker glaze down one side of the body: negative left, positive right, 0 none. Size is strength.'),
  shadeWidth: num(0.2, 0, 1, 'Width of the side glaze where it starts at muzzle height, as a fraction of the body width.'),
  shadeGrow: num(0.3, 0, 2, 'How much wider the side glaze gets per px of drop.'),
  chestX: num(0, -1200, 1200, 'Chest patch centre, sideways from the centre line, px.'),
  chestY: num(420, -500, 3000, 'Chest patch centre below the top of the head, px.'),
  chestSize: num(0, 0, 400, 'Chest patch half-width, px. 0 hides it.'),
  chestStretch: num(1.4, 0.3, 3, 'Chest patch height over width.'),
  cast: num(0, -1, 1, 'Shadow cast past one side onto whatever is behind: negative left, positive right, 0 none. Size is strength.'),
  castWidth: num(40, 0, 400, 'How far the cast shadow reaches past the side where it starts, px.'),
  castLength: num(500, 1, 4000, 'Distance down the side over which the cast shadow narrows to nothing, px.'),
  color: col('#f24921', 'Body wash colour. Use the paper colour for a white bear left as bare paper.'),
  muzzleColor: col('#fefdf9', 'Muzzle tint laid over the reserved paper.'),
  earColor: col('#d63510', 'Inner ear wash colour.'),
  castColor: col('#a8505a', 'Cast shadow glaze, laid in multiply over whatever is behind.'),
  shadeColor: col('#d93a15', 'Darker glaze for pooled edges, bridge, chin, side shade and dark streaks.'),
  noseColor: col('#15151b', 'Nose pigment.'),
  inkColor: col('#141418', 'Eyes, brows and mouth.'),
  paper: col('#fefdf9', 'Paper colour, reserved under the body, muzzle and eye whites.'),
  layers: num(26, 4, 48, 'Translucent wash layers for the body. Other regions scale from this.'),
  roughness: num(0.5, 0, 1, 'Fray of the deformed outlines.'),
  earMarks: num(0.6, 0, 1, 'Brush marks inside the ears: lifted hatching on a painted bear, a scribbled tint on a bare-paper one.'),
  softness: num(1.5, 0, 30, 'How far wash edges wander between layers, px. Higher gives softer, bleedier edges.'),
  pooling: num(0.6, 0, 1, 'Darker pigment pooled along drying wash edges.'),
  mottle: num(0.5, 0, 1, 'Wet-in-wet unevenness: soft darker and paler patches inside the body.'),
  brushwork: num(0.5, 0, 1, 'Long overlapping brush strokes glazed over the body wash, with dried hard edges.'),
  blooms: num(0.4, 0, 1, 'Number and strength of cauliflower blooms (backruns).'),
  granulation: num(0.5, 0, 1, 'Pigment granulation specks settling in the paper.'),
  streaks: num(0.5, 0, 1, 'Density of broken dry-brush streaks, lighter and darker, denser near the sides.'),
  ragged: num(0.5, 0, 1, 'Dry-brush flecks dragged down the sides, poking out past the edge so it looks ragged.'),
  tooth: num(0.5, 0, 1, 'Paper tooth showing through the wash as pale specks.'),
};

/** Base outline spacing in local px before fraying; fraying halves it twice. */
const SPACING = 34;

interface Body {
  L: number;
  R: number;
  flareL: number;
  flareR: number;
  bulgeL: number;
  bulgeR: number;
  length: number;
  corner: number;
  dome: number;
}

/** Distance over which a side's bulge builds up, local px. */
const BULGE_SPAN = 180;

/** Distance from the centre line to one side (-1 left, 1 right) at depth y below the top. */
function halfWidth(b: Body, side: number, y: number): number {
  const yy = Math.max(0, y);
  const [w, flare, bulge] = side < 0 ? [b.L, b.flareL, b.bulgeL] : [b.R, b.flareR, b.bulgeR];
  return w + flare * yy + bulge * (1 - Math.exp(-yy / BULGE_SPAN));
}

function sideSlope(b: Body, side: number, y: number): number {
  const [flare, bulge] = side < 0 ? [b.flareL, b.bulgeL] : [b.flareR, b.bulgeR];
  return flare + (bulge * Math.exp(-Math.max(0, y) / BULGE_SPAN)) / BULGE_SPAN;
}

/** Tombstone outline, clockwise from the left shoulder. Corner arcs meet the sides tangentially. */
function bodyPoints(b: Body): Pt[] {
  const r = clamp(b.corner, 1, Math.max(1, Math.min(halfWidth(b, -1, 0), halfWidth(b, 1, 0), b.length / 2)));
  const pts: Pt[] = [];
  const cxL = -halfWidth(b, -1, r) + r;
  const cxR = halfWidth(b, 1, r) - r;
  const aL = Math.PI + Math.atan(sideSlope(b, -1, r));
  const aR = -Math.atan(sideSlope(b, 1, r));
  for (let i = 0; i <= 8; i++) {
    const a = aL + ((1.5 * Math.PI - aL) * i) / 8;
    pts.push([cxL + Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  for (let i = 1; i < 12; i++) {
    const u = i / 12;
    pts.push([cxL + (cxR - cxL) * u, -b.dome * 4 * u * (1 - u)]);
  }
  for (let i = 0; i <= 8; i++) {
    const a = -0.5 * Math.PI + ((aR + 0.5 * Math.PI) * i) / 8;
    pts.push([cxR + Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  // Sides: sampled densely near the top where the bulge bends them, then shifted to meet the arc ends.
  const side = (s: number, y0: number, x0: number): Pt[] => {
    const shift = x0 - s * halfWidth(b, s, y0);
    const out: Pt[] = [];
    const bottom = Math.max(b.length, y0 + 1);
    for (let i = 1; i <= 24; i++) {
      const y = y0 + (bottom - y0) * (i / 24) ** 1.6;
      out.push([s * halfWidth(b, s, y) + shift, y]);
    }
    return out;
  };
  pts.push(...side(1, r + Math.sin(aR) * r, cxR + Math.cos(aR) * r));
  pts.push(...side(-1, r + Math.sin(aL) * r, cxL + Math.cos(aL) * r).reverse());
  return pts;
}

/** Egg outline, width w at its widest: taper > 0 narrows the top, taper < 0 the bottom. square < 1 squares it off. */
function eggPoints(cx: number, cy: number, w: number, h: number, taper: number, square: number, count = 40): Pt[] {
  const raw: Pt[] = [];
  const pow = (v: number) => Math.sign(v) * Math.abs(v) ** square;
  let widest = 1e-6;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    const s = pow(Math.sin(a));
    const px = pow(Math.cos(a)) * (1 - (taper * (1 - s)) / 2);
    widest = Math.max(widest, Math.abs(px));
    raw.push([px, s]);
  }
  return raw.map(([px, s]) => [cx + (w / 2) * (px / widest), cy + (h / 2) * s]);
}

/** Stage corners mapped into the bear's local frame, as a box. */
function stageBox(stage: Stage, x: number, y: number, angle: number, scale: number): Box {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [sx, sy] of [
    [0, 0],
    [stage.width, 0],
    [0, stage.height],
    [stage.width, stage.height],
  ]) {
    const dx = (sx - x) / scale;
    const dy = (sy - y) / scale;
    xs.push(dx * cos - dy * sin);
    ys.push(dx * sin + dy * cos);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function intersect(a: Box, b: Box): Box {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

export const watercolorBear: Rig = {
  id: 'watercolor-bear',
  description:
    'Watercolour study of a stacked, tombstone-shaped bear: rounded-top body running off the bottom of the stage, ' +
    'round ears, dot eyes with brow dashes, a reserved-paper muzzle, a dense pigment nose with a lifted highlight and ' +
    'a line mouth. Every colour region is 10 to 50 translucent layers of a recursively deformed polygon, with pooled ' +
    'edges, glaze strokes with one hard and one blended edge, wet-in-wet mottling, cauliflower blooms, granulation, ' +
    'dry-brush flecks and ragged sides, scribbled pale patches, an optional cast shadow onto the bear behind, and paper tooth.',
  params,
  // No `parts`: the washes interleave across regions, so the draw is not split into kit.part segments,
  // and a rig that declares parts must wrap every mark in one (docs/SCENES.md, Rig rules).
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const scale = p.number('scale');
    const angle = degToRad(p.number('tilt'));
    const x = p.number('x');
    const y = p.number('y');
    const view = stageBox(stage, x, y, angle, scale);

    const L = p.number('bodyLeft');
    const R = p.number('bodyRight');
    const flareL = p.number('flareLeft');
    const flareR = p.number('flareRight');
    const length = p.number('length') > 0 ? p.number('length') : Math.max(80, view.y1 + 60);
    const body: Body = {
      L,
      R,
      flareL,
      flareR,
      bulgeL: p.number('bulgeLeft'),
      bulgeR: p.number('bulgeRight'),
      length,
      corner: p.number('shoulder') * Math.min(L, R),
      dome: p.number('dome'),
    };

    const paper = p.string('paper');
    const color = p.string('color');
    const shade = p.string('shadeColor');
    const layers = p.integer('layers');
    const rough = p.number('roughness');
    const soft = p.number('softness');
    const pooling = p.number('pooling');

    const earSize = p.number('earSize');
    const earSpread = p.number('earSpread');
    const earY = p.number('earY');

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);

    // Outlines: smooth shapes resampled, then frayed once for the painting's own wobble.
    const bodyRing = fray(ringFrom(bodyPoints(body), SPACING, 160), rng.fork('body-shape'), 0.09 * rough, 2);
    const ears: Ring[] =
      earSize > 0
        ? [-1, 1].map((side) =>
            fray(
              ringFrom(circlePoints(side * earSpread, earY, earSize, 28), Math.max(4, earSize / 5), 40),
              rng.fork(side < 0 ? 'ear-left-shape' : 'ear-right-shape'),
              0.08 * rough,
              2,
            ),
          )
        : [];
    // A bear painted in the paper colour is bare paper: no wash, and the reserve itself is the shape.
    const bare = color.trim().toLowerCase() === paper.trim().toLowerCase();
    // Clip paths are copied into every paint call's state, so they use a thinned outline.
    const bodyClip = thin(bodyRing, 2);
    const earClips = ears.map((ear) => thin(ear, 2));
    const silhouette = (grow: number) => {
      ctx.beginPath();
      traceRing(ctx, offsetRing(bodyClip, grow));
      for (const ear of earClips) traceRing(ctx, offsetRing(ear, grow));
    };

    // 0. Cast shadow on whatever is behind, laid first so the bear's own reserve and wash cover its inner half.
    const cast = p.number('cast');
    const castWidth = p.number('castWidth');
    if (cast !== 0 && castWidth > 0) {
      drawCast(ctx, rng.fork('cast'), body, cast, castWidth, p.number('castLength'), earY + earSize, p.string('castColor'), view);
    }

    // 1. Paper reserve, a little inside the wash edge, so the core of every wash sits on clean paper while
    //    its soft outer edge still glazes over whatever is behind.
    if (paintable(paper)) {
      ctx.fillStyle = paper;
      silhouette(bare ? 0 : -soft * 1.2);
      ctx.fill();
    }

    // 2. Body washes, ears first so the head overlaps them.
    const washAlpha = 1 - Math.pow(0.03, 1 / layers); // this many layers of this alpha reach 97 percent colour
    const poolStyle = {
      color: shade,
      passes: Math.ceil(3 + 6 * pooling),
      alpha: 0.2 * pooling,
      width: 2.4,
      inset: bare ? 1.5 : soft * 0.5 + 1.5,
      spread: 0.6 + soft * 0.2,
    };
    if (!bare) wash(ctx, ears, rng.fork('ear-wash'), { color, layers: Math.ceil(layers * 0.7), alpha: washAlpha * 1.2, spread: soft, bias: -0.3, stride: 2 });
    // Ear rims pool only where the ear stands clear of the head: clip to everything outside the body.
    if (ears.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x0 - 1000, view.y0 - 1000, view.x1 - view.x0 + 2000, view.y1 - view.y0 + 2000);
      traceRing(ctx, bodyClip);
      ctx.clip('evenodd');
      pool(ctx, ears, rng.fork('ear-pool'), { ...poolStyle, passes: Math.ceil(2 + 3 * pooling) });
      ctx.restore();
    }
    if (!bare) wash(ctx, bodyRing, rng.fork('body-wash'), { color, layers, alpha: washAlpha, spread: soft, bias: -0.3, stride: 2 });

    // Ragged sides: the dry brush dragged down each side leaves flecks sticking out past the edge.
    const ragged = p.number('ragged');
    const raggedInk = bare ? paper : color;
    if (ragged > 0 && paintable(raggedInk)) {
      const rr = rng.fork('ragged');
      const top = body.corner * 1.1;
      const bottom = Math.min(length, view.y1);
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const n = Math.min(350, Math.round((Math.max(0, bottom - top) / 5) * ragged));
        for (let i = 0; i < n; i++) {
          const yy = top + rr.next() * (bottom - top);
          const lean = s * Math.atan(sideSlope(body, s, yy)) + gauss(rr) * 0.04;
          const len = 8 + rr.next() ** 2 * 60;
          fleckPath(ctx, rr, s * (halfWidth(body, s, yy) + rr.next() * 5 - 1.5), yy, len, lean, 1.2 + rr.next() * 2);
        }
      }
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = raggedInk;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 3. Everything that lives inside the silhouette, clipped to it.
    const tex = intersect(view, {
      x0: -halfWidth(body, -1, length) - Math.abs(body.bulgeL) - earSize,
      y0: Math.min(earY - earSize, -body.dome) - 4,
      x1: halfWidth(body, 1, length) + Math.abs(body.bulgeR) + earSize,
      y1: length,
    });
    ctx.save();
    silhouette(bare ? 0 : soft * 0.3);
    ctx.clip();

    drawMottle(ctx, rng.fork('mottle'), tex, p.number('mottle'), shade, paper, soft);
    drawBrushwork(ctx, rng.fork('brushwork'), body, tex, p.number('brushwork'), bare ? shade : color, paper, shade, bare);
    const side = p.number('shadeSide');
    if (side !== 0) {
      const width = p.number('shadeWidth') * (halfWidth(body, -1, 0) + halfWidth(body, 1, 0));
      drawSideShade(ctx, rng.fork('side-shade'), body, side, width, p.number('shadeGrow'), p.number('muzzleY'), shade, soft, pooling);
    }
    drawBlooms(ctx, rng.fork('blooms'), tex, p.number('blooms'), paper, shade);
    drawStreaks(ctx, rng.fork('streaks'), body, tex, p.number('streaks'), { paper, color, shade }, bare);
    drawGranules(ctx, rng.fork('granules'), tex, p.number('granulation'), shade);

    // Pigment drifts to the drying edge: a soft darkening toward the rim, then the hard pooled line itself.
    if (pooling > 0) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = shade;
      ctx.lineJoin = 'round';
      const rim = offsetRing(bodyClip, bare ? 0 : -soft * 0.3);
      for (const [width, alpha] of [
        [26, 0.05],
        [12, 0.07],
        [5, 0.09],
      ]) {
        ctx.globalAlpha = alpha * pooling * (bare ? 0.6 : 1);
        ctx.lineWidth = width;
        ctx.beginPath();
        traceRing(ctx, rim);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    pool(ctx, bodyRing, rng.fork('body-pool'), poolStyle);
    ctx.restore();

    // 4. Inner ears: a tint dropped into the damp ear so it spreads with a soft edge, then brush marks.
    const earColor = p.string('earColor');
    const marks = p.number('earMarks');
    ears.forEach((_, i) => {
      const s = i === 0 ? -1 : 1;
      const cx = s * (earSpread + earSize * 0.06);
      const cy = earY - earSize * 0.04;
      const er = rng.fork(`inner-ear-${i}`);
      const inner = fray(ringFrom(eggPoints(cx, cy, earSize * 1.3, earSize * 1.2, 0.1, 1, 24), Math.max(3, earSize / 5), 24), er, 0.2 * rough, 2);
      wash(ctx, inner, er, { color: earColor, layers: 8, alpha: bare ? 0.1 : 0.07, spread: 1 + earSize * 0.08 + soft, bias: -1 });
      if (marks <= 0) return;
      if (bare) {
        ctx.beginPath();
        scribblePath(ctx, er, cx, cy, earSize * 0.66, earSize * 0.62, 30);
        strokeMarks(ctx, mix(earColor, shade, 65), 0.6 * marks, Math.max(1, earSize * 0.035));
      } else {
        // Lifted hatching: parallel strokes leaning in toward the head, pale where the brush picked pigment back up.
        const a = -s * 0.65;
        const dx = Math.sin(a);
        const dy = Math.cos(a);
        ctx.beginPath();
        for (let k = -3; k <= 3; k++) {
          const len = earSize * (0.85 - 0.1 * Math.abs(k)) * (0.8 + 0.4 * er.next());
          const ox = cx + dy * k * earSize * 0.14 - dx * len * 0.5 + gauss(er) * earSize * 0.03;
          const oy = cy - dx * k * earSize * 0.14 - dy * len * 0.5 + gauss(er) * earSize * 0.03;
          fleckPath(ctx, er, ox, oy, len, a + gauss(er) * 0.08, Math.max(1, earSize * 0.07));
        }
        ctx.globalAlpha = 0.6 * marks;
        ctx.fillStyle = mix(color, paper, 55);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });

    // 5. Face, in the order a painter would glaze it.
    const fx = p.number('faceX');
    const noseY = p.number('noseY');
    const nw = p.number('noseWidth');
    const nh = p.number('noseHeight');
    const my = p.number('muzzleY');
    const mw = p.number('muzzleWidth');
    const mh = p.number('muzzleHeight');

    const chestSize = p.number('chestSize');
    if (chestSize > 0) {
      const cr = rng.fork('chest');
      const cx = p.number('chestX');
      const cy = p.number('chestY');
      const ry = chestSize * p.number('chestStretch');
      const chest = fray(ringFrom(eggPoints(cx, cy, chestSize * 2, ry * 2, 0.15, 1, 28), Math.max(3, chestSize / 5), 30), cr, 0.16 * rough, 2);
      wash(ctx, chest, cr, { color: earColor, layers: 8, alpha: 0.06, spread: 1 + chestSize * 0.1 + soft, bias: -1 });
      if (marks > 0) {
        ctx.beginPath();
        scribblePath(ctx, cr, cx, cy, chestSize * 0.95, ry * 0.95, 10 + (chestSize * ry) / 120);
        strokeMarks(ctx, mix(earColor, shade, 50), 0.45 * marks, Math.max(1, chestSize * 0.028));
      }
    }

    const bridge = p.number('bridge');
    if (bridge > 0 && nw > 0 && nh > 0) {
      const br = rng.fork('bridge');
      const top = noseY - nh * 1.35;
      const capR = nw * 0.15;
      // Rounded cap from the left over the top to the right, then the wide base under the nose: clockwise on screen.
      const pts: Pt[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI + (Math.PI * i) / 10;
        pts.push([fx + Math.cos(a) * capR, top + capR + Math.sin(a) * capR]);
      }
      pts.push([fx + nw * 0.47, noseY + nh * 0.1], [fx - nw * 0.47, noseY + nh * 0.1]);
      glaze(ctx, fray(ringFrom(pts, 8, 40), br, 0.1 * rough, 2), br, shade, bridge, layers, soft, pooling);
    }

    const chin = p.number('chin');
    if (chin > 0 && mw > 0 && mh > 0) {
      const cr = rng.fork('chin');
      const ring = fray(ringFrom(eggPoints(fx - mw * 0.05, my + mh * 0.34, mw * 0.94, mh * 0.72, -0.15, 0.9), 8, 40), cr, 0.12 * rough, 2);
      glaze(ctx, ring, cr, shade, chin, layers, soft, pooling);
    }

    // Muzzle: paper lifted back to white, then its own tint, a pooled rim and a few chalky contour strokes.
    if (mw > 0 && mh > 0) {
      const mr = rng.fork('muzzle');
      const ring = fray(ringFrom(eggPoints(fx, my, mw, mh, 0.24, 0.9), 8, 50), mr, 0.07 * rough, 2);
      wash(ctx, ring, mr, { color: paper, layers: Math.ceil(layers * 0.35), alpha: 0.5, spread: 0.8 + soft * 0.2, bias: -0.3, stride: 2 });
      const tint = p.string('muzzleColor');
      if (tint.trim().toLowerCase() !== paper.trim().toLowerCase()) {
        wash(ctx, ring, mr, { color: tint, layers: Math.ceil(layers * 0.5), alpha: 0.22, spread: 1 + soft * 0.3, bias: -0.5, stride: 2 });
      }
      pool(ctx, ring, mr, { color: mix(tint, shade, 55), passes: 3, alpha: 0.16 * pooling, width: 1.8, inset: 2, spread: 0.8 });
      contourStrokes(ctx, mr, fx, my, mw, mh, mix(tint, shade, 55), 0.28);
    }

    // Paper tooth over the painted body: pale specks where pigment skipped the peaks of the paper.
    const toothAmount = p.number('tooth');
    if (toothAmount > 0) {
      ctx.save();
      silhouette(bare ? 0 : soft * 0.3);
      ctx.clip();
      const tr = rng.fork('tooth');
      specks(ctx, tr, tex, {
        color: paper,
        alpha: 0.3 + 0.35 * toothAmount,
        density: 3 * toothAmount,
        size: [0.8, 2.2],
        mask: valueNoise(tr.fork('mask'), 7),
        max: 6000,
      });
      ctx.restore();
    }

    // Nose: dense pigment, a darker pooled rim, then a highlight lifted back toward paper.
    if (nw > 0 && nh > 0) {
      const nr = rng.fork('nose');
      const noseColor = p.string('noseColor');
      const ring = fray(ringFrom(eggPoints(fx, noseY, nw, nh, -0.32, 0.72), 5, 50), nr, 0.06 * rough, 2);
      wash(ctx, ring, nr, { color: noseColor, layers: Math.ceil(layers * 0.3), alpha: 0.5, spread: 0.8, bias: -0.3, jitter: 0.5 });
      // Uneven pigment: a cooler, slightly lighter pool low in the nose, where the wash thinned as it dried.
      wash(ctx, offsetRing(ring, -nh * 0.18), nr, {
        color: mix(noseColor, '#46406e', 70),
        layers: 5,
        alpha: 0.08,
        spread: nh * 0.1,
        bias: -0.4,
      });
      ctx.save();
      ctx.beginPath();
      traceRing(ctx, offsetRing(ring, -1.5));
      ctx.clip();
      specks(ctx, nr, { x0: fx - nw / 2, y0: noseY - nh / 2, x1: fx + nw / 2, y1: noseY + nh / 2 }, {
        color: '#000000',
        alpha: 0.5,
        density: 14,
        size: [0.6, 1.6],
        mask: valueNoise(nr.fork('mask'), 6),
        max: 800,
      });
      ctx.restore();
      pool(ctx, ring, nr, { color: noseColor, passes: 2, alpha: 0.6, width: 1.8, inset: 1.2, spread: 0.5, gaps: 0.2 });
      // Highlight lifted back toward paper: a soft lifted halo, a brighter core, then pigment specks left in it.
      const hx0 = fx - nw * 0.3;
      const hx1 = fx + nw * 0.2;
      const hy = noseY - nh * 0.24;
      ctx.fillStyle = paper;
      for (const [alpha, width] of [
        [0.12, 0.2],
        [0.95, 0.11],
      ]) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        const j = gauss(nr) * 0.4;
        taperedStroke(ctx, [hx0 + j, hy + nh * 0.03], [fx - nw * 0.05, hy - nh * 0.14], [hx1 - j, hy - nh * 0.01], nh * width);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      specks(ctx, nr.fork('lift'), { x0: hx0, y0: hy - nh * 0.14, x1: hx1, y1: hy + nh * 0.06 }, {
        color: noseColor,
        alpha: 0.7,
        density: 40,
        size: [0.6, 1.4],
        mask: valueNoise(nr.fork('lift-mask'), 4),
        max: 300,
      });
    }

    // Eyes: reserved whites, then pupils dropped in wet so they bleed a little.
    const ink = p.string('inkColor');
    const eyeY = p.number('eyeY');
    const eyeSpacing = p.number('eyeSpacing');
    const eyeSize = p.number('eyeSize');
    const scleraR = eyeSize * (1 + 0.9 * p.number('sclera'));
    const lookX = p.number('lookX');
    const lookY = p.number('lookY');
    if (eyeSize > 0) {
      for (const s of [-1, 1]) {
        const er = rng.fork(s < 0 ? 'eye-left' : 'eye-right');
        const ex = fx + s * eyeSpacing;
        if (scleraR > eyeSize * 1.05) {
          const white = fray(ringFrom(eggPoints(ex, eyeY, scleraR * 2.2, scleraR * 1.8, 0, 1, 24), 2, 24), er, 0.06 * rough, 1);
          wash(ctx, white, er, { color: paper, layers: 4, alpha: 0.65, spread: 0.6, bias: -0.2, jitter: 0.3 });
        }
        const room = Math.max(0, scleraR * 1.05 - eyeSize * 0.8);
        const px = ex + lookX * room;
        const py = eyeY + lookY * room * 0.7;
        const pupil = ringFrom(circlePoints(px, py, eyeSize, 20), 1.5, 24);
        wash(ctx, pupil, er, { color: ink, layers: 4, alpha: 0.6, spread: 0.7, bias: -0.2, jitter: 0.25 });
      }

      // Brow dashes, inner ends raised by browTilt.
      const lift = p.number('browLift');
      const tiltB = degToRad(p.number('browTilt'));
      const bl = Math.max(eyeSize * 3.2, eyeSpacing * 0.42);
      ctx.fillStyle = ink;
      for (const s of [-1, 1]) {
        const bx = fx + s * (eyeSpacing + eyeSize * 0.3);
        const by = eyeY - lift;
        const dx = (Math.cos(tiltB) * bl) / 2;
        const dy = (Math.sin(tiltB) * bl) / 2;
        const outer: Pt = [bx + s * dx, by + dy];
        const inner: Pt = [bx - s * dx, by - dy];
        const c: Pt = [bx, by - bl * 0.12];
        for (let k = 0; k < 2; k++) {
          ctx.globalAlpha = k === 0 ? 0.85 : 0.45;
          ctx.beginPath();
          taperedStroke(ctx, outer, c, inner, eyeSize * (0.62 + 0.25 * k));
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Mouth: a line dropping from the nose into a small smile.
    const drop = p.number('mouthDrop');
    const sw = p.number('smileWidth');
    const lineW = Math.max(1.2, eyeSize * 0.42);
    if (drop > 0 || sw > 0) {
      const mr = rng.fork('mouth');
      const top = noseY + nh * 0.42;
      const bottom = noseY + nh / 2 + drop;
      ctx.fillStyle = ink;
      for (let k = 0; k < 2; k++) {
        ctx.globalAlpha = k === 0 ? 0.9 : 0.35;
        const w = lineW * (1 + 0.5 * k);
        ctx.beginPath();
        if (drop > 0) taperedStroke(ctx, [fx, top], [fx - drop * 0.05 + gauss(mr) * 0.5, (top + bottom) / 2], [fx - drop * 0.02, bottom], w);
        if (sw > 0) {
          const depth = sw * 0.24;
          taperedStroke(ctx, [fx - sw / 2, bottom - depth], [fx, bottom + depth], [fx + sw / 2, bottom - depth * 1.05], w);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  },
};

/** Wet-in-wet unevenness: big soft blotches, some a darker glaze, some pigment lifted back toward paper. */
function drawMottle(ctx: Ctx2D, rng: Rng, box: Box, amount: number, shade: string, paper: string, soft: number): void {
  if (amount <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
  const count = 3 + Math.round(amount * 5);
  const dark: Ring[] = [];
  const light: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const r = 70 + rng.next() * 190;
    const cx = box.x0 + rng.next() * (box.x1 - box.x0);
    const cy = box.y0 + rng.next() * (box.y1 - box.y0);
    (i % 2 === 0 ? dark : light).push(fray(ringFrom(circlePoints(cx, cy, r, 20), r / 6, 30), rng, 0.2, 1));
  }
  wash(ctx, dark, rng, { color: shade, layers: 5, alpha: 0.05 * amount, spread: 50 + soft, bias: -0.5 });
  wash(ctx, light, rng, { color: paper, layers: 5, alpha: 0.035 * amount, spread: 50 + soft, bias: -0.5 });
}

/**
 * A glaze down one side, from the muzzle to the bottom, widening steadily so it
 * can reach out past a bear standing in front. Hard inner edge, like a shadow
 * laid on dry paper.
 */
function drawSideShade(
  ctx: Ctx2D,
  rng: Rng,
  b: Body,
  side: number,
  width: number,
  grow: number,
  fromY: number,
  shade: string,
  soft: number,
  pooling: number,
): void {
  const s = side < 0 ? -1 : 1;
  const y0 = Math.max(fromY, 0);
  const y1 = Math.max(b.length, y0 + 1);
  const edge = (yy: number) => s * halfWidth(b, s, yy);
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const yy = y0 + ((y1 - y0) * i) / 12;
    outer.push([edge(yy) + s * 60, yy]);
    inner.push([edge(yy) - s * Math.max(2, width + grow * (yy - y0)), yy]);
  }
  // Clockwise on screen: for the right band go down the outer edge and back up the inner one, for the left the reverse.
  const pts = s > 0 ? [...outer, ...inner.reverse()] : [...inner, ...outer.reverse()];
  glaze(ctx, fray(ringFrom(pts, 24, 60), rng, 0.1, 2), rng, shade, Math.abs(side), 20, soft, pooling);
}

/**
 * A shadow cast past one side onto the bear behind: a multiply glaze hugging
 * the side, hard where it meets the body and blended out on the far edge,
 * narrowing to nothing further down.
 */
function drawCast(
  ctx: Ctx2D,
  rng: Rng,
  b: Body,
  cast: number,
  width: number,
  length: number,
  fromY: number,
  color: string,
  view: Box,
): void {
  if (!paintable(color)) return;
  const s = cast < 0 ? -1 : 1;
  const y0 = Math.max(fromY, b.corner * 0.5);
  const y1 = Math.min(y0 + length, Math.max(b.length, y0 + 1), view.y1 + width);
  if (y1 <= y0) return;
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const yy = y0 + (y1 - y0) * u;
    const edge = s * halfWidth(b, s, yy);
    // Swells in over the first fifth, then narrows to nothing.
    const reach = width * Math.min(1, u * 5) * (1 - u) ** 0.8;
    outer.push([edge + s * Math.max(1, reach), yy]);
    inner.push([edge - s * 12, yy]);
  }
  // Clockwise on screen: for the right side go down the outer edge and back up the inner one, for the left the reverse.
  const pts = s > 0 ? [...outer, ...inner.reverse()] : [...inner, ...outer.reverse()];
  const cx = (edgeAt: number) => s * halfWidth(b, s, edgeAt);
  const ring = withSoftness(fray(ringFrom(pts, 10, 60), rng, 0.08, 2), (px, py) => ((px - cx(py)) * s > 2 ? 1 + Math.min(width, 60) * 0.12 : 1));
  const n = 6;
  const alpha = 1 - Math.pow(1 - 0.5 * Math.abs(cast), 1 / n);
  wash(ctx, ring, rng, { color, layers: n, alpha, spread: 2, bias: -0.2, composite: 'multiply', stride: 2 });
}

/**
 * A glaze on dry paper: a few layers of one colour with a tight edge, then the
 * pigment that pooled along that edge. strength 1 covers about 75 percent.
 */
function glaze(
  ctx: Ctx2D,
  ring: Ring,
  rng: Rng,
  color: string,
  strength: number,
  layers: number,
  soft: number,
  pooling: number,
): void {
  if (strength <= 0) return;
  const n = Math.max(3, Math.ceil(layers * 0.3));
  const alpha = (1 - Math.pow(0.25, 1 / n)) * strength;
  wash(ctx, ring, rng, { color, layers: n, alpha, spread: 0.8 + soft * 0.3, bias: -0.3 });
  pool(ctx, ring, rng, { color, passes: 3, alpha: 0.3 * pooling * strength, width: 1.8, inset: 1.2, spread: 0.6, gaps: 0.3 });
}

/**
 * Long brush strokes glazed over the dry body wash. Each is a bent, tapering
 * ribbon following the lean of the sides, with one hard edge where the stroke
 * dried (pigment pooled along it) and one soft edge where it was blended out.
 * Glazed in multiply so overlaps build up darker. A few are soft lifts back toward paper.
 */
function drawBrushwork(
  ctx: Ctx2D,
  rng: Rng,
  b: Body,
  box: Box,
  amount: number,
  color: string,
  paper: string,
  shade: string,
  bare: boolean,
): void {
  if (amount <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
  const count = Math.round(3 + 11 * amount);
  const glazes: Ring[] = [];
  const lifts: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const y0 = box.y0 + rng.next() * (box.y1 - box.y0) * 0.8;
    const left = -halfWidth(b, -1, y0);
    const right = halfWidth(b, 1, y0);
    const x0 = left + (right - left) * rng.next();
    const len = 160 + rng.next() * 600;
    const w = 26 + rng.next() * 90;
    const lean = leanAt(b, x0, y0) + gauss(rng) * 0.05;
    const dx = Math.sin(lean);
    const dy = Math.cos(lean);
    const bend = gauss(rng) * len * 0.05;
    const wobble = rng.next() * TAU;
    const sideA: Pt[] = [];
    const sideB: Pt[] = [];
    const steps = 12;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      // Loaded at the start, running dry and narrowing toward the end.
      const swell = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.25 + 0.08)) ** 0.5;
      const half = (w / 2) * swell * (1 - 0.4 * t) * (0.9 + 0.2 * Math.sin(t * 9 + wobble));
      const off = bend * 4 * t * (1 - t);
      const cx = x0 + dx * len * t + dy * off;
      const cy = y0 + dy * len * t - dx * off;
      sideA.push([cx + dy * half, cy - dx * half]);
      sideB.push([cx - dy * half, cy + dx * half]);
    }
    // Clockwise on screen: down the right-hand side, back up the left.
    const ring = fray(ringFrom([...sideB, ...sideA.reverse()], 14, 44), rng, 0.12, 2);
    const hard = rng.next() < 0.5 ? 1 : -1;
    if (!bare && rng.next() < 0.25) {
      lifts.push(withSoftness(ring, () => 5));
    } else {
      // Softness from which side of the stroke's axis a vertex sits on.
      glazes.push(withSoftness(ring, (px, py) => ((px - x0) * dy - (py - y0) * dx) * hard > 0 ? 1 : 6));
    }
  }
  wash(ctx, glazes, rng, { color, layers: 5, alpha: (bare ? 0.035 : 0.06) * amount, spread: 1.5, bias: -0.3, composite: 'multiply', stride: 2 });
  wash(ctx, lifts, rng, { color: paper, layers: 5, alpha: 0.035 * amount, spread: 1.5, bias: -0.5, stride: 2 });
  pool(ctx, glazes, rng, { color: shade, passes: 1, alpha: (bare ? 0.12 : 0.22) * amount, width: 1.3, inset: 0.6, spread: 0.5, gaps: 0.4 });
}

function drawBlooms(ctx: Ctx2D, rng: Rng, box: Box, amount: number, paper: string, shade: string): void {
  if (amount <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
  const count = Math.round(amount * 5);
  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    const cx = box.x0 + rng.next() * (box.x1 - box.x0);
    const cy = box.y0 + rng.next() * (box.y1 - box.y0);
    rings.push(bloomRing(rng, cx, cy, 25 + rng.next() * 55));
  }
  blooms(ctx, rng, rings, 50, paper, shade, amount);
}

interface StreakInks {
  paper: string;
  color: string;
  shade: string;
}

/** Irregular dash pattern for the fine hair lines: the brush skipping over the paper tooth. */
const DRY_DASH = [16, 4, 5, 3, 28, 6, 3, 2, 11, 5, 7, 9, 21, 3, 4, 4];

/** Lean of the brush at a point: follows the left side near the left edge and the right side near the right. */
function leanAt(b: Body, x: number, y: number): number {
  const left = -halfWidth(b, -1, y);
  const right = halfWidth(b, 1, y);
  const u = clamp((x - left) / Math.max(1, right - left), 0, 1);
  return -Math.atan(sideSlope(b, -1, y)) * (1 - u) + Math.atan(sideSlope(b, 1, y)) * u;
}

/**
 * Dry brush dragged down the body, more of it near the sides: tapered flecks
 * where the brush skipped the paper (pale) or dumped pigment (dark), in small
 * clusters like the hairs of one stroke, plus a few long broken hair lines.
 * Batched by ink, so the whole field costs a handful of paint calls.
 */
function drawStreaks(ctx: Ctx2D, rng: Rng, b: Body, box: Box, amount: number, inks: StreakInks, bare: boolean): void {
  if (amount <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  const clusters = Math.min(600, Math.round((amount * area) / 1000));
  // A bare-paper bear has no pigment to skip, so it only gets the darker drags.
  const styles = [
    { color: mix(inks.color, inks.paper, 22), alpha: 0.9, share: bare ? 0 : 0.45, composite: 'source-over' as const },
    { color: mix(inks.color, inks.paper, 60), alpha: 0.6, share: bare ? 0 : 0.25, composite: 'source-over' as const },
    { color: inks.shade, alpha: bare ? 0.3 : 0.32, share: bare ? 0.5 : 0.2, composite: 'multiply' as const },
  ];
  const place = (): [number, number] => {
    const yy = box.y0 + rng.next() * (box.y1 - box.y0);
    const left = -halfWidth(b, -1, yy);
    const right = halfWidth(b, 1, yy);
    const fromEdge = rng.next() ** 2.2 * (right - left) * 0.55;
    return [rng.next() < 0.5 ? left + fromEdge : right - fromEdge, yy];
  };
  for (const style of styles) {
    const n = Math.round(clusters * style.share);
    if (n <= 0) continue;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [xx, yy] = place();
      const lean = leanAt(b, xx, yy) + gauss(rng) * 0.07;
      const len = 7 + rng.next() ** 2 * 70;
      const hairs = 1 + rng.int(0, 4);
      const gap = 3 + rng.next() * 5;
      for (let h = 0; h < hairs; h++) {
        const across = (h - (hairs - 1) / 2) * gap + gauss(rng) * 1.2;
        const shift = rng.next() * len * 0.5;
        const hx = xx + Math.cos(lean) * across + Math.sin(lean) * shift;
        const hy = yy - Math.sin(lean) * across + Math.cos(lean) * shift;
        fleckPath(ctx, rng, hx, hy, len * (0.4 + 0.6 * rng.next()), lean + gauss(rng) * 0.03, 1.1 + rng.next() * 1.9);
      }
    }
    ctx.globalCompositeOperation = style.composite;
    ctx.globalAlpha = style.alpha;
    ctx.fillStyle = style.color;
    ctx.fill();
  }

  // Long broken hair lines.
  const hairInks = bare ? [inks.shade] : [inks.paper, inks.shade];
  hairInks.forEach((ink, si) => {
    ctx.beginPath();
    const n = Math.round(clusters * 0.15);
    for (let i = 0; i < n; i++) {
      const [xx, yy] = place();
      const lean = leanAt(b, xx, yy) + gauss(rng) * 0.05;
      streakPath(ctx, rng, xx, yy, 40 + rng.next() * 120, lean);
    }
    const k = (si * 7) % DRY_DASH.length;
    ctx.setLineDash([...DRY_DASH.slice(k), ...DRY_DASH.slice(0, k)]);
    ctx.lineDashOffset = rng.next() * 40;
    ctx.globalCompositeOperation = ink === inks.shade ? 'multiply' : 'source-over';
    ctx.globalAlpha = ink === inks.shade ? 0.3 : 0.55;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawGranules(ctx: Ctx2D, rng: Rng, box: Box, amount: number, shade: string): void {
  if (amount <= 0) return;
  const mask = valueNoise(rng.fork('mask'), 22);
  specks(ctx, rng.fork('fine'), box, { color: shade, alpha: 0.45, density: 3.2 * amount, size: [0.6, 1.5], composite: 'multiply', mask, max: 5000 });
  specks(ctx, rng.fork('coarse'), box, { color: shade, alpha: 0.25, density: 0.8 * amount, size: [1.4, 2.6], composite: 'multiply', mask, max: 1500 });
}

/** Stroke the current path as thin brush marks. */
function strokeMarks(ctx: Ctx2D, color: string, alpha: number, width: number): void {
  if (!paintable(color) || alpha <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Short strokes following the muzzle outline, the chalky brush texture of a pale shape. */
function contourStrokes(ctx: Ctx2D, rng: Rng, cx: number, cy: number, w: number, h: number, color: string, alpha: number): void {
  if (!paintable(color)) return;
  ctx.beginPath();
  for (let i = 0; i < 22; i++) {
    const a = rng.next() * TAU;
    const k = 0.35 + 0.55 * Math.sqrt(rng.next());
    const sweep = 0.15 + rng.next() * 0.35;
    const steps = 6;
    for (let j = 0; j <= steps; j++) {
      const aa = a + (sweep * j) / steps;
      const px = cx + Math.cos(aa) * (w / 2) * k;
      const py = cy + Math.sin(aa) * (h / 2) * k;
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
