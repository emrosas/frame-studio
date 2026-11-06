import type { Rig } from '../../engine/types';
import { bool, choice, col, num, readParams, str } from '../parts/params';
import { GLYPH_HEIGHT, lineWidth, paintLine } from './font';

/** Bitmap text for pixel stages, on an optional card. */
export const pixelText: Rig = {
  id: 'pixel-text',
  description:
    'Bitmap capitals for a pixel stage, whole pixels at any integer size, with an optional card behind. ' +
    'Use "|" for a new line. reveal types it on, 0 to 1. Give a caption depth 0 so the camera leaves it alone.',
  params: {
    text: str('HELLO', 'The words. "|" starts a new line.'),
    x: num(90, -2000, 4000, 'Anchor x in stage pixels.'),
    y: num(40, -2000, 4000, 'Top of the text in stage pixels.'),
    size: num(1, 1, 16, 'Stage pixels per font pixel, a whole number.'),
    align: choice('center', ['left', 'center', 'right'], 'How lines sit on x.'),
    color: col('#f6efd8', 'Text colour.'),
    reveal: num(1, 0, 1, 'Share of the characters showing, for typing on.'),
    card: bool(false, 'Draw a card behind the text.'),
    cardColor: col('#14122b', 'Card colour.'),
    edgeColor: col('#e8a33d', 'Line along the card\'s top and bottom.'),
    pad: num(4, 0, 40, 'Card padding in stage pixels.'),
    opacity: num(1, 0, 1, 'Opacity.'),
  },
  draw(ctx, raw) {
    const p = readParams(pixelText.params, raw);
    const size = Math.max(1, Math.round(p.number('size')));
    const lines = p.string('text').split('|');
    const gap = 2 * size;
    const height = lines.length * GLYPH_HEIGHT * size + (lines.length - 1) * gap;
    const widths = lines.map((l) => lineWidth(l) * size);
    const x = Math.round(p.number('x'));
    const y = Math.round(p.number('y'));
    const left = (w: number) => (p.string('align') === 'left' ? x : p.string('align') === 'right' ? x - w : x - Math.floor(w / 2));
    ctx.globalAlpha = p.number('opacity');
    if (p.boolean('card')) {
      const pad = Math.round(p.number('pad'));
      const w = Math.max(...widths);
      const cx = left(w) - pad;
      const cw = w + pad * 2;
      const ch = height + pad * 2;
      ctx.fillStyle = p.string('cardColor');
      ctx.fillRect(cx, y - pad, cw, ch);
      ctx.fillStyle = p.string('edgeColor');
      ctx.fillRect(cx, y - pad, cw, 1);
      ctx.fillRect(cx, y - pad + ch - 1, cw, 1);
    }
    ctx.fillStyle = p.string('color');
    const fill = (fx: number, fy: number, w: number, h: number) => ctx.fillRect(fx, fy, w, h);
    let left2 = Math.ceil(p.number('reveal') * lines.reduce((n, l) => n + [...l].length, 0));
    lines.forEach((line, i) => {
      paintLine(fill, line, left(widths[i]), y + i * (GLYPH_HEIGHT * size + gap), size, left2);
      left2 -= [...line].length;
    });
  },
};
