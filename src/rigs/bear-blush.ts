/**
 * bear.blush: the bear with rosy cheeks, painted in the same dry-brush gouache
 * as the rest of it (Frame Studio request #1, from references/bears-reference.png).
 *
 * It draws the base bear through drawBear, part for part, and adds one part,
 * `blush`: a soft wash on each cheek, beside the muzzle and below the eyes,
 * with a few dry strokes of a lighter pink across it. The cheeks sit in the
 * face frame, so they follow faceX, faceY and faceTilt. They go on after the
 * body and before the face, are clipped to the head, and restore every bit of
 * context state they change, so the base parts draw exactly as on `bear`.
 */
import type { Ctx2D, ParamSchema, Rig, Rng } from '../engine/types';
import { bear, drawBear, type Body } from './bear';
import { degToRad } from './parts/math';
import { Brush, dryStroke, eggPoints, EVERYWHERE, mixColor, paintable, tracePoly, wash, washShape, wobble } from './parts/paint';
import { col, num, readParams, type ParamReader } from './parts/params';

const blushParams: ParamSchema = {
  blushX: num(0.27, 0.05, 0.6, 'How far each cheek sits from the nose, sideways, as a fraction of width.'),
  blushY: num(0.06, -0.3, 0.4, 'Cheek height below the nose centre, as a fraction of width.'),
  blushSize: num(0.085, 0, 0.3, 'Cheek width, as a fraction of width. 0 hides the blush.'),
  blushColor: col('#ff7a86', 'Colour of the cheeks.'),
  blushStrength: num(0.55, 0, 1, 'How strongly the cheeks show, 0 to 1.'),
};

const params: ParamSchema = { ...bear.params, ...blushParams };

export const bearBlush: Rig = {
  id: 'bear.blush',
  description:
    'The bear with rosy cheeks: a soft gouache wash on each cheek with a few dry strokes across it. Takes every bear ' +
    'param and draws exactly what bear draws, plus the blush part.',
  params,
  parts: [...(bear.parts ?? []), 'blush'],
  draw(ctx, values, t, rng, stage, kit) {
    drawBear(ctx, values, t, rng, stage, kit, {
      head(c, body) {
        kit.part('blush', () => {
          c.save();
          drawBlush(c, body, readParams(params, values), rng.fork('blush'));
          c.restore();
        });
      },
    });
  },
};

/** Both cheeks, starting in the body frame. */
function drawBlush(ctx: Ctx2D, b: Body, p: ParamReader, rng: Rng): void {
  const W = b.W;
  const rx = (p.number('blushSize') * W) / 2;
  const color = p.string('blushColor');
  const strength = p.number('blushStrength');
  if (rx < 1 || !(strength > 0) || !paintable(color)) return;
  const light = mixColor(color, '#ffffff', 0.35);

  // Clip to the head, then move into the face frame, where the cheeks are placed.
  ctx.beginPath();
  tracePoly(ctx, b.outline);
  ctx.clip();
  ctx.translate(p.number('faceX') * W, p.number('faceY') * W);
  ctx.rotate(degToRad(p.number('faceTilt')));

  const brush = new Brush(EVERYWHERE);
  for (const side of [-1, 1]) {
    const r = rng.fork(side < 0 ? 'left' : 'right');
    const cx = side * p.number('blushX') * W;
    const cy = p.number('blushY') * W;
    const ry = rx * 0.68;
    const outline = wobble(eggPoints(cx, cy, rx, ry, { squareness: 2.2, rotation: side * 0.12 }, 36), r.fork('shape'), rx * 0.08, 4);
    // A few translucent copies give the soft, uneven edge of a gouache wash.
    wash(ctx, [washShape(outline)], r.fork('wash'), { color, layers: 4, alpha: 0.2 * strength, spread: rx * 0.22, bias: -0.2, waveLength: rx * 3 });
    // Dry strokes of a lighter pink across the cheek, along the grain of the fur.
    const rs = r.fork('strokes');
    for (let i = 0; i < 5; i++) {
      const v = rs.range(-0.45, 0.45) * ry;
      const u0 = cx + rs.range(-0.8, -0.2) * rx;
      const u1 = cx + rs.range(0.2, 0.8) * rx;
      dryStroke(brush, rs, {
        x0: u0, y0: cy + v, cx: (u0 + u1) / 2, cy: cy + v + rs.range(-0.1, 0.1) * ry, x1: u1, y1: cy + v + rs.range(-0.15, 0.15) * ry,
        width: ry * rs.range(0.25, 0.45), bristles: rs.int(3, 6), color: rs.next() < 0.6 ? light : color,
        alpha: rs.range(0.12, 0.28) * strength, gaps: 0.55,
      });
    }
    brush.flush(ctx);
  }
}
