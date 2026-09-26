/**
 * iris: a round opening with a slightly ragged, hand-cut edge, for the iris
 * transitions in Bears' story. As a layer's mask, with radius keys, the layer
 * shows only inside it (ADR 0007): key the radius up from 0 to open onto a
 * shot, or down to 0 to close on one. A rig of this project only, so it lives
 * in projects/bears-story/rigs/ rather than src/rigs/.
 */
import type { Rig } from '../../../src/engine/types';
import { TAU } from '../../../src/rigs/parts/math';
import { sampleCircle, traceSmoothLoop, wobbleOutline } from '../../../src/rigs/parts/outline';
import { col, num, readParams } from '../../../src/rigs/parts/params';

const params = {
  x: num(960, -10000, 10000, 'Centre x in scene pixels.'),
  y: num(540, -10000, 10000, 'Centre y in scene pixels.'),
  radius: num(600, 0, 5000, 'Radius of the opening in scene pixels. 1110 covers a 1920x1080 stage from its centre.'),
  rough: num(8, 0, 60, 'How ragged the cut edge is, in scene pixels. 0 is a clean circle.'),
  fill: col('#1b1712', 'Colour of the opening. Only its shape matters when the iris is a mask.'),
};

export const iris: Rig = {
  id: 'iris',
  description: 'A round opening with a hand-cut edge, for iris transitions: use it as a mask and key its radius.',
  params,
  draw(ctx, values, _t, rng) {
    const p = readParams(params, values);
    const radius = p.number('radius');
    if (radius <= 0) return;
    const rough = Math.min(p.number('rough'), radius / 4);
    ctx.save();
    ctx.translate(p.number('x'), p.number('y'));
    ctx.beginPath();
    // The edge comes from the layer's seed alone, so it holds still while the radius moves.
    if (rough > 0) traceSmoothLoop(ctx, wobbleOutline(sampleCircle(radius), rough, rng.fork('edge')));
    else ctx.arc(0, 0, radius, 0, TAU);
    ctx.fillStyle = p.string('fill');
    ctx.fill();
    ctx.restore();
  },
};
