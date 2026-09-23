/**
 * bear.bandaged: the bear with a sticking plaster across its head.
 *
 * It draws the base bear through drawBear, part for part, and adds one part,
 * `plaster`: two crossed strips with a gauze pad where they cross, painted
 * like the rest of the bear and clipped to the head so the plaster wraps over
 * the edge instead of sticking out past it. The plaster goes on after the
 * body and before the face, and restores every bit of context state it
 * changes, so the base parts draw exactly as they do on `bear`.
 */
import type { Ctx2D, ParamSchema, Rig, Rng } from '../engine/types';
import { bear, drawBear, type Body } from './bear';
import { degToRad } from './parts/math';
import {
  Brush, Marks, brokenRim, dryStroke, eggPoints, fillPoly, mixColor, paintable, ragEdge, tracePoly, wash, washShape, wobble,
  EVERYWHERE, type Pt,
} from './parts/paint';
import { col, num, readParams, type ParamReader } from './parts/params';

const plasterParams: ParamSchema = {
  plasterX: num(0.36, -0.7, 0.7, 'Plaster centre x in the body frame, as a fraction of width.'),
  plasterY: num(0.05, -0.2, 2, 'Plaster centre y below the top edge of the head, as a fraction of width.'),
  plasterAngle: num(-28, -90, 90, 'Turn of the whole plaster in degrees, clockwise.'),
  plasterSize: num(0.28, 0.05, 0.8, 'Length of each strip, as a fraction of width.'),
  plasterColor: col('#efcb98', 'Colour of the plaster strips.'),
  plasterPad: col('#fbf7ee', 'Colour of the gauze pad where the strips cross.'),
};

const params: ParamSchema = { ...bear.params, ...plasterParams };

/** The strips cross at this angle either side of plasterAngle. */
const CROSS = degToRad(38);

export const bearBandaged: Rig = {
  id: 'bear.bandaged',
  description:
    'The bear with a sticking plaster across its head: two crossed painted strips with a gauze pad. Takes every bear ' +
    'param and draws exactly what bear draws, plus the plaster part.',
  params,
  parts: [...(bear.parts ?? []), 'plaster'],
  draw(ctx, values, t, rng, stage, kit) {
    drawBear(ctx, values, t, rng, stage, kit, {
      head(c, body) {
        kit.part('plaster', () => {
          c.save();
          drawPlaster(c, body, readParams(params, values), rng.fork('plaster'));
          c.restore();
        });
      },
    });
  },
};

/** The plaster, in the body frame. */
function drawPlaster(ctx: Ctx2D, b: Body, p: ParamReader, rng: Rng): void {
  const W = b.W;
  const len = p.number('plasterSize') * W;
  const wid = len * 0.28;
  const color = p.string('plasterColor');
  if (len < 4 || !paintable(color)) return;
  const pad = p.string('plasterPad');
  const shade = p.string('shade');
  const rough = p.number('edgeRough');
  const dark = mixColor(color, '#6b4a2a', 0.3);
  const light = mixColor(color, '#ffffff', 0.35);

  // Clip to the head, so a plaster over the edge looks wrapped round it.
  ctx.beginPath();
  tracePoly(ctx, b.outline);
  ctx.clip();
  ctx.translate(p.number('plasterX') * W, p.number('plasterY') * W);
  ctx.rotate(degToRad(p.number('plasterAngle')));

  const strips = [-1, 1].map((k) => {
    const r = rng.fork(k < 0 ? 'under' : 'over');
    const outline = wobble(eggPoints(0, 0, len / 2, wid / 2, { squareness: 5, rotation: k * CROSS }, 44), r.fork('shape'), wid * 0.035 * rough, 4);
    return { k, r, outline };
  });

  // A soft shade on the fur, down and right of the strips.
  const shadeShapes = strips.map((s) => washShape(s.outline.map(([x, y]): Pt => [x + W * 0.006, y + W * 0.014])));
  wash(ctx, shadeShapes, rng.fork('shade'), { color: shade, layers: 3, alpha: 0.2, spread: W * 0.008, bias: -0.3, waveLength: len });

  const brush = new Brush(EVERYWHERE);
  const marks = new Marks(EVERYWHERE);
  for (const s of strips) {
    fillPoly(ctx, s.outline, color);
    const loop = [...s.outline, ...s.outline.slice(0, 3)];
    ragEdge(brush, s.r.fork('edge'), loop, 0, loop.length - 1, rough * (0.4 + W * 0.0015), 0.4, color);
    brush.flush(ctx);

    ctx.save();
    ctx.beginPath();
    tracePoly(ctx, s.outline);
    ctx.clip();
    ctx.rotate(s.k * CROSS);
    // Dry streaks along the strip, a little lighter and darker than the plaster.
    const rs = s.r.fork('streaks');
    for (let i = 0; i < 9; i++) {
      const v = rs.range(-0.4, 0.4) * wid;
      const u0 = rs.range(-0.55, 0.2) * len;
      const u1 = u0 + rs.range(0.25, 0.6) * len;
      dryStroke(brush, rs, {
        x0: u0, y0: v, cx: (u0 + u1) / 2, cy: v + rs.range(-0.05, 0.05) * wid, x1: u1, y1: v + rs.range(-0.08, 0.08) * wid,
        width: wid * rs.range(0.15, 0.3), bristles: rs.int(3, 6), color: rs.next() < 0.55 ? light : dark,
        alpha: rs.range(0.15, 0.35), gaps: 0.6,
      });
    }
    brush.flush(ctx);
    // Breathing holes on the sticky ends.
    const rd = s.r.fork('holes');
    for (const end of [-1, 1]) {
      for (const u of [0.27, 0.37]) {
        for (const v of [-0.22, 0, 0.22]) {
          const x = end * u * len + rd.range(-0.01, 0.01) * len;
          const y = v * wid + rd.range(-0.03, 0.03) * wid;
          const dot = wobble(eggPoints(x, y, wid * 0.045, wid * 0.05, {}, 8), rd, wid * 0.01, 2);
          marks.shape(dark, 0.6, dot.flat());
        }
      }
    }
    marks.flush(ctx);
    ctx.restore();
    brokenRim(ctx, washShape(s.outline), s.r.fork('rim'), {
      color: dark, alpha: 0.55, width: Math.max(0.8, W * 0.0028), inset: Math.max(1, wid * 0.04), gaps: 0.3, passes: 2,
      composite: 'source-over',
    });
  }

  // The gauze pad where the strips cross, cross-hatched with fine threads.
  if (paintable(pad)) {
    const rp = rng.fork('pad');
    const side = wid * 0.62;
    const padPts = wobble(eggPoints(0, 0, side, side * 0.92, { squareness: 4.5 }, 32), rp.fork('shape'), side * 0.04, 3);
    fillPoly(ctx, padPts, pad);
    ctx.save();
    ctx.beginPath();
    tracePoly(ctx, padPts);
    ctx.clip();
    const thread = mixColor(pad, color, 0.55);
    for (let i = 0; i < 14; i++) {
      const across = i % 2 === 0;
      const o = rp.range(-0.9, 0.9) * side;
      const a: Pt = across ? [-side, o] : [o, -side];
      const z: Pt = across ? [side, o + rp.range(-0.1, 0.1) * side] : [o + rp.range(-0.1, 0.1) * side, side];
      dryStroke(brush, rp, {
        x0: a[0], y0: a[1], cx: (a[0] + z[0]) / 2, cy: (a[1] + z[1]) / 2, x1: z[0], y1: z[1],
        width: side * rp.range(0.05, 0.1), bristles: 1, color: thread, alpha: rp.range(0.25, 0.5), gaps: 0.4,
      });
    }
    brush.flush(ctx);
    ctx.restore();
    brokenRim(ctx, washShape(padPts), rp.fork('rim'), {
      color: mixColor(pad, '#8a7a66', 0.35), alpha: 0.6, width: Math.max(0.8, W * 0.0025), inset: Math.max(1, side * 0.06),
      gaps: 0.25, passes: 2, composite: 'source-over',
    });
  }
}
