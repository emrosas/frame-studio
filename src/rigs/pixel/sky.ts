import type { Rig } from '../../engine/types';
import { col, num, readParams } from '../parts/params';

/** A three-stop sky with a low sun. */
export const sky: Rig = {
  id: 'sky',
  description:
    'A vertical sky in three colours with an optional sun and rings of glow. Use it as a background. With a palette and dither on the scene, the gradient dithers on its own.',
  params: {
    top: col('#2a1b5e', 'Colour at the top.'),
    middle: col('#a8467a', 'Colour at the horizon line.'),
    bottom: col('#f3a35c', 'Colour at the bottom.'),
    horizon: num(0.6, 0.05, 0.95, 'Where the middle colour sits, 0 top to 1 bottom.'),
    sunX: num(0.5, -1, 2, 'Sun x as a share of the width.'),
    sunY: num(0.55, -1, 2, 'Sun y as a share of the height.'),
    sunSize: num(0, 0, 200, 'Sun radius in stage pixels. 0 for no sun.'),
    sun: col('#ffe6a0', 'Sun colour.'),
    glow: num(2.4, 1, 6, 'Glow radius as a multiple of the sun.'),
  },
  draw(ctx, raw, _t, _rng, stage) {
    const p = readParams(sky.params, raw);
    const horizon = p.number('horizon');
    const wash = ctx.createLinearGradient(0, 0, 0, stage.height);
    wash.addColorStop(0, p.string('top'));
    wash.addColorStop(horizon, p.string('middle'));
    wash.addColorStop(1, p.string('bottom'));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, stage.width, stage.height);
    const r = p.number('sunSize');
    if (r <= 0) return;
    const x = p.number('sunX') * stage.width;
    const y = p.number('sunY') * stage.height;
    ctx.fillStyle = p.string('sun');
    // Hard rings, not a soft glow: a palette keeps bands where a gradient would only speckle.
    const rings = 5;
    for (let i = rings; i >= 0; i--) {
      ctx.globalAlpha = i === 0 ? 1 : 0.13;
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + ((p.number('glow') - 1) * i) / rings), 0, Math.PI * 2);
      ctx.fill();
    }
  },
};
