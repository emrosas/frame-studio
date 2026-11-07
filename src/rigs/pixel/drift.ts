import type { Rig } from '../../engine/types';
import { col, num, readParams } from '../parts/params';

/** Seeded points drifting in closed form: snow, stars, dust, particles. */
export const drift: Rig = {
  id: 'drift',
  description:
    'Many small seeded squares drifting across a box, in closed form, wrapping at its edges: snow, stars, dust, molecules. ' +
    'twinkle blinks them. It computes each dot from t, so seeking gives the same picture.',
  params: {
    count: num(40, 1, 2000, 'How many.'),
    x: num(0, -2000, 4000, 'Box left in stage pixels.'),
    y: num(0, -2000, 4000, 'Box top in stage pixels.'),
    width: num(180, 1, 4000, 'Box width.'),
    height: num(320, 1, 4000, 'Box height.'),
    size: num(1, 1, 16, 'Dot size in stage pixels.'),
    vx: num(0, -500, 500, 'Drift right, stage pixels a second.'),
    vy: num(6, -500, 500, 'Drift down, stage pixels a second.'),
    jitter: num(0, 0, 40, 'Side-to-side wander in stage pixels.'),
    twinkle: num(0, 0, 8, 'Blinks a second. 0 for steady.'),
    color: col('#f6efd8', 'Colour.'),
    opacity: num(1, 0, 1, 'Opacity.'),
  },
  draw(ctx, raw, t, rng) {
    const p = readParams(drift.params, raw);
    const [x0, y0, w, h] = [p.number('x'), p.number('y'), p.number('width'), p.number('height')];
    const size = Math.max(1, Math.round(p.number('size')));
    const [vx, vy, jitter, twinkle] = [p.number('vx'), p.number('vy'), p.number('jitter'), p.number('twinkle')];
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    ctx.fillStyle = p.string('color');
    ctx.globalAlpha = p.number('opacity');
    const count = Math.round(p.number('count'));
    for (let i = 0; i < count; i++) {
      const [ax, ay, speed, phase] = [rng.next(), rng.next(), rng.range(0.6, 1.4), rng.range(0, 6.28)];
      if (twinkle > 0 && Math.sin(t * twinkle * 6.28 + phase) < -0.2) continue;
      const dx = wrap(ax * w + vx * speed * t + jitter * Math.sin(t * 1.3 + phase), w);
      const dy = wrap(ay * h + vy * speed * t, h);
      ctx.fillRect(Math.round(x0 + dx), Math.round(y0 + dy), size, size);
    }
  },
};
