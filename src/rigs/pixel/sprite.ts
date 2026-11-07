import type { Rig } from '../../engine/types';
import { bool, num, readParams, str } from '../parts/params';

const parseColours = (text: string): Map<string, string> => new Map(text.split(/[\s,]+/).filter(Boolean).map((pair) => [pair[0], pair.slice(2)]));

/** Pixel art written out as text. */
export const sprite: Rig = {
  id: 'sprite',
  description:
    'Pixel art written as text. rows has one string of cells per row, split with "|"; "." is clear and any other ' +
    'character takes its colour from colors, as "a=#ffffff b=#222244". Several frames split with "/" cycle at fps.',
  params: {
    rows: str('.aa.|abba|abba|.aa.', 'Rows split by "|", frames split by "/".'),
    colors: str('a=#14122b b=#f6efd8', 'Each cell character with its colour.'),
    x: num(90, -4000, 4000, 'Centre x in stage pixels.'),
    y: num(160, -4000, 4000, 'Centre y in stage pixels.'),
    size: num(1, 1, 32, 'Stage pixels per cell, a whole number.'),
    fps: num(6, 0, 60, 'Frames a second, when there are several.'),
    flip: bool(false, 'Mirror left to right.'),
    opacity: num(1, 0, 1, 'Opacity.'),
  },
  draw(ctx, raw, t) {
    const p = readParams(sprite.params, raw);
    const frames = p.string('rows').split('/');
    const rows = frames[Math.floor(t * p.number('fps')) % frames.length].split('|');
    const colours = parseColours(p.string('colors'));
    const size = Math.max(1, Math.round(p.number('size')));
    const width = Math.max(...rows.map((r) => r.length));
    const left = Math.round(p.number('x') - (width * size) / 2);
    const top = Math.round(p.number('y') - (rows.length * size) / 2);
    const flip = p.boolean('flip');
    ctx.globalAlpha = p.number('opacity');
    rows.forEach((row, ry) => {
      for (let i = 0; i < row.length; i++) {
        const colour = colours.get(row[i]);
        if (row[i] === '.' || !colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(left + (flip ? width - 1 - i : i) * size, top + ry * size, size, size);
      }
    });
  },
};
