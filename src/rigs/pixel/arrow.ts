import type { Rig } from '../../engine/types';
import { col, num, readParams } from '../parts/params';

/** A blocky arrow for showing a force, a flow or where to look. */
export const arrow: Rig = {
  id: 'arrow',
  description: 'A blocky arrow from (x, y), pointing up, down, left or right by angle, for forces and flows. Animate length to grow it.',
  params: {
    x: num(90, -4000, 4000, 'Tail x in stage pixels.'),
    y: num(160, -4000, 4000, 'Tail y in stage pixels.'),
    length: num(40, 1, 2000, 'Length in stage pixels, head included.'),
    width: num(5, 1, 100, 'Shaft width.'),
    head: num(6, 1, 100, 'Head half-width.'),
    angle: num(-90, -360, 360, 'Direction in degrees: 0 right, -90 up, 90 down.'),
    color: col('#7fd8f0', 'Colour.'),
    outline: col('#14122b', 'Outline. "none" for no outline.'),
    opacity: num(1, 0, 1, 'Opacity.'),
  },
  draw(ctx, raw) {
    const p = readParams(arrow.params, raw);
    const len = Math.round(p.number('length'));
    if (len <= 0) return;
    const shaft = Math.round(p.number('width'));
    const head = Math.round(p.number('head'));
    const tall = Math.min(len, head + 1);
    ctx.globalAlpha = p.number('opacity');
    ctx.translate(Math.round(p.number('x')), Math.round(p.number('y')));
    ctx.rotate((Math.round(p.number('angle') / 90) * Math.PI) / 2);
    const paint = (grow: number, colour: string) => {
      ctx.fillStyle = colour;
      ctx.fillRect(-grow, -Math.floor(shaft / 2) - grow, Math.max(0, len - tall) + grow * 2, shaft + grow * 2);
      for (let i = 0; i < tall; i++) {
        const half = Math.round(head * (1 - i / tall)) + grow;
        ctx.fillRect(len - tall + i, -half, 1, half * 2 + 1);
      }
    };
    if (p.string('outline') !== 'none') paint(1, p.string('outline'));
    paint(0, p.string('color'));
  },
};
