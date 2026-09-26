/**
 * bearArm: one bear arm on a layer of its own, painted exactly like the
 * bear's paws (bear-paws.ts), for when an arm has to reach in front of a
 * layer drawn after its bear. Frame Studio request #3: Bruno reaches over
 * Pip, who is in front of him, to put a plaster on Pip's head.
 *
 * Give it the bear's width and paint params so it matches, put the shoulder
 * inside the bear's body, and set `hidePaw` on the bear for the same frames so
 * the bear does not draw that paw as well. Animate `angle` and `length` with
 * tracks for the reach.
 */
import type { ParamSchema, Rig } from '../engine/types';
import { bear } from './bear';
import { drawArm } from './bear-paws';
import { degToRad } from './parts/math';
import { num, readParams } from './parts/params';

const fromBear = ['width', 'pawSize', 'body', 'shade', 'rimColor', 'scratch', 'tonal', 'strokes', 'scratches', 'scratchWidth', 'edgeRough', 'dryness'];

const params: ParamSchema = {
  x: num(540, -10000, 10000, 'Scene x of the shoulder. Put it inside the bear body the arm belongs to.'),
  y: num(900, -10000, 10000, 'Scene y of the shoulder.'),
  angle: num(-30, -360, 360, 'Direction from the shoulder to the paw, in degrees clockwise from pointing right.'),
  length: num(0.5, 0, 2, 'Distance from the shoulder to the paw centre, as a fraction of width.'),
  ...Object.fromEntries(fromBear.map((name) => [name, bear.params[name]])),
  // An arm layer is there to draw its paw, so unlike the bear's, its paw can't be hidden with 0.
  pawSize: num(0.2, 0.05, 0.5, 'Paw width, as a fraction of width. Match the bear.'),
};

export const bearArm: Rig = {
  id: 'bearArm',
  description:
    'One bear arm on its own layer, painted like the bear paws, for an arm that reaches in front of a later layer. ' +
    'Copy the bear width and paint params, and hide that paw on the bear with hidePaw.',
  params,
  draw(ctx, values, _t, rng) {
    const p = readParams(params, values);
    const W = p.number('width');
    drawArm(ctx, W, p, rng.fork('arm'), p.number('x'), p.number('y'), degToRad(p.number('angle')), p.number('length') * W);
  },
};
