// PROTOTYPE pastel ground for the pastel study: a flat sheet of coloured paper with a faint worked layer on its tooth.
import type { ParamSchema, Rig } from '../../../engine/types';
import { degToRad } from '../../parts/math';
import { readParams } from '../../parts/params';
import { mix } from './color';
import { crayon, isNone, makePaper, Palette } from './crayon';

const params: ParamSchema = {
  color: { type: 'color', default: '#ffa200', description: 'Paper colour, which is also the flat ground.' },
  texture: { type: 'number', default: 0.5, min: 0, max: 1, description: 'Amount of faint lighter and darker pastel worked over the ground.' },
  mottle: { type: 'number', default: 0.4, min: 0, max: 1, description: 'Strength of large soft light and dark patches.' },
  angle: { type: 'number', default: 18, min: -90, max: 90, description: 'Direction of the ground strokes, degrees from vertical.' },
  grain: { type: 'number', default: 0.9, min: 0, max: 1, description: 'Paper tooth strength, as on pastel-bear.' },
  toothScale: {
    type: 'number',
    default: 1,
    min: 0.3,
    max: 4,
    description: 'Size of the paper tooth. Keep it equal to the bears so the grain lines up.',
  },
};

export const pastelGround: Rig = {
  id: 'pastel-ground',
  description:
    'PROTOTYPE pastel ground: fills the stage with a flat paper colour, then works faint lighter and darker strokes ' +
    'over it that catch only on the shared paper tooth, plus soft mottling.',
  params,
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const base = p.string('color');
    const { width, height } = stage;
    if (isNone(base)) return;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    const mottle = p.number('mottle');
    if (mottle > 0) {
      const m = rng.fork('mottle');
      const size = Math.max(width, height);
      for (let i = 0; i < 8; i++) {
        const x = m.range(0, width);
        const y = m.range(0, height);
        const r = m.range(0.12, 0.3) * size;
        const tone = m.next() < 0.5 ? mix(base, '#ffffff', 0.35) : mix(base, '#b04000', 0.35);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, tone);
        g.addColorStop(1, mix(tone, base, 1));
        ctx.globalAlpha = mottle * m.range(0.12, 0.25);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    }

    const texture = p.number('texture');
    if (texture <= 0) return;
    const paper = makePaper(width, height, p.number('toothScale'), p.number('grain'));
    const pal = new Palette();
    const light = [pal.stick(mix(base, '#ffffff', 0.12), 2.2, 0.6), pal.stick(mix(base, '#ffffff', 0.07), 2.6, 0.6)];
    const dark = [pal.stick(mix(base, '#c24a00', 0.1), 2.2, 0.6), pal.stick(mix(base, '#c24a00', 0.06), 2.6, 0.6)];
    const a = degToRad(p.number('angle'));
    const dx = Math.sin(a);
    const dy = Math.cos(a);
    const s = rng.fork('strokes');
    const count = Math.min(1500, Math.round((texture * width * height) / 9000));
    for (let i = 0; i < count; i++) {
      const x = s.range(-40, width + 40);
      const y = s.range(-40, height + 40);
      const len = s.range(80, 320);
      const turn = s.range(-0.12, 0.12);
      const ex = dx + Math.cos(a) * turn;
      const ey = dy - Math.sin(a) * turn;
      const pts = [x, y, x + ex * len * 0.5 + s.range(-4, 4), y + ey * len * 0.5, x + ex * len, y + ey * len];
      const sticks = s.next() < 0.55 ? light : dark;
      crayon(sticks[s.int(0, sticks.length)], pts, s.range(0.12, 0.3), paper, { ramp: 0.4, lanes: 4 });
    }
    pal.flush(ctx);
  },
};
