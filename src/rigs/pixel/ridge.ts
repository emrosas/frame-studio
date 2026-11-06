import type { Rig } from '../../engine/types';
import { col, num, readParams } from '../parts/params';

/** A seeded landscape line, for parallax. */
export const ridge: Rig = {
  id: 'ridge',
  description:
    'A seeded skyline filled down to the bottom of the stage: hills, or a city with blocks above 0. Stack a few with different ' +
    'layer depths and a moving camera for parallax. It runs well past the stage on both sides.',
  params: {
    y: num(220, -2000, 4000, 'The ground line in stage pixels.'),
    height: num(30, 0, 1000, 'How far above y it reaches.'),
    roughness: num(0.5, 0, 1, 'Hills: 0 rolls, 1 is jagged.'),
    blocks: num(0, 0, 200, 'Width of city blocks in stage pixels. 0 for hills.'),
    color: col('#2b2158', 'Fill.'),
    extent: num(2, 1, 8, 'How many stage widths it runs across.'),
  },
  draw(ctx, raw, _t, rng, stage) {
    const p = readParams(ridge.params, raw);
    const y = p.number('y');
    const height = p.number('height');
    const span = stage.width * p.number('extent');
    const left = Math.round(stage.width / 2 - span / 2);
    const right = left + Math.round(span);
    const bottom = Math.ceil(stage.height + height + stage.height * 2);
    // One closed path, so a camera zoom can't open seams between columns.
    ctx.fillStyle = p.string('color');
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    const blocks = p.number('blocks');
    if (blocks > 0) {
      const b = rng.fork('blocks');
      for (let x = left; x < right; ) {
        const w = Math.max(2, Math.round(blocks * b.range(0.6, 1.6)));
        const top = Math.round(y - height * b.range(0.25, 1));
        ctx.lineTo(x, top);
        ctx.lineTo(x + w, top);
        x += w;
      }
    } else {
      const w1 = rng.range(0, 6.28);
      const w2 = rng.range(0, 6.28);
      const w3 = rng.range(0, 6.28);
      const rough = p.number('roughness');
      for (let x = left; x <= right; x++) {
        const k = (x / stage.width) * 6.28;
        const n = (Math.sin(k * 0.9 + w1) + 0.6 * Math.sin(k * 2.1 + w2) + rough * 0.5 * Math.sin(k * 5.3 + w3) + rough * 0.25 * Math.sin(k * 11 + w1)) / 2.4;
        ctx.lineTo(x, Math.round(y - height * (0.5 + n / 2)));
      }
    }
    ctx.lineTo(right, bottom);
    ctx.closePath();
    ctx.fill();
  },
};
