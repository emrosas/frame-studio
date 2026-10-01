import type { Rig } from '../engine/types';
import { col, readParams } from './parts/params';

const params = { color: col('#000000', 'The colour that fills the stage, any CSS colour string.') };

/** A solid colour over the whole stage: a composition's background (ADR 0013), or a flat backdrop in a scene. */
export const fill: Rig = {
  id: 'fill',
  description: 'Fills the whole stage with one colour. A composition\'s background is this rig.',
  params,
  draw(ctx, values, _t, _rng, stage) {
    const p = readParams(params, values);
    ctx.fillStyle = p.string('color');
    ctx.fillRect(0, 0, stage.width, stage.height);
  },
};
