import type { ParamSchema, Rig } from '../../engine/types';
import { choice, col, num, readParams } from '../parts/params';
import { degToRad } from '../parts/math';
import { typefaces } from './faces/index';
import { blockTop, characterCount, layoutText, traceText, type TextAlign, type TextVAlign } from './layout';

const isPainted = (c: string) => c !== 'none' && c !== 'transparent' && c !== '';

const params: ParamSchema = {
  text: { type: 'string', default: 'Hello', description: 'The text. "\\n" starts a new line.' },
  font: choice(
    typefaces[0].id,
    typefaces.map((f) => f.id),
    `The typeface: ${typefaces.map((f) => `${f.id} (${f.name})`).join(', ')}.`,
  ),
  size: num(96, 1, 2000, 'Font size in scene pixels per em.'),
  x: num(960, -10000, 10000, 'Anchor x in scene pixels. align says which part of each line sits on it.'),
  y: num(540, -10000, 10000, 'Anchor y in scene pixels. valign says which part of the block sits on it.'),
  align: choice('center', ['left', 'center', 'right'], 'Each line starts at the anchor, centres on it, or ends at it.'),
  valign: choice('middle', ['top', 'middle', 'baseline', 'bottom'], "The block's top, middle, first baseline or bottom sits on the anchor."),
  width: num(0, 0, 10000, 'Wrap lines at this width in scene pixels, at spaces and hyphens. 0 breaks only at newlines.'),
  lineHeight: num(1.2, 0.5, 4, 'Line height as a multiple of the size.'),
  tracking: num(0, -300, 1000, 'Letter spacing in thousandths of an em.'),
  case: choice('none', ['none', 'upper', 'lower'], 'Draw the text as written, in capitals, or in lower case.'),
  fill: col('#1c1b19', 'Fill colour, any CSS colour string. "none" skips the fill.'),
  stroke: col('none', 'Outline colour, any CSS colour string. "none" skips the outline.'),
  strokeWidth: num(0, 0, 100, 'Outline width in scene pixels at scale 1. 0 skips the outline.'),
  opacity: num(1, 0, 1, 'Opacity, 0 to 1.'),
  rotation: num(0, -36000, 36000, 'Rotation in degrees about the anchor, clockwise on screen.'),
  scale: num(1, 0, 20, 'Uniform scale about the anchor.'),
  reveal: num(1, 0, 1, 'How much of the text shows, 0 to 1, in reading order. Animate it to type the text on; the layout never moves.'),
};

/**
 * Text drawn from a typeface module (ADR 0010): the same glyphs, kerning and
 * line breaks on every machine and in every export. No fonts are loaded and
 * the canvas never measures anything.
 */
export const text: Rig = {
  id: 'text',
  description:
    'Text in one of the built-in typefaces, drawn as vector outlines: kerned, tracked, wrapped at a width, aligned on an anchor. ' +
    'Animate reveal to type it on.',
  params,
  draw(ctx, values) {
    const p = readParams(params, values);
    const opacity = p.number('opacity');
    const reveal = p.number('reveal');
    const face = typefaces.find((f) => f.id === p.string('font')) ?? typefaces[0];
    const casing = p.string('case');
    const raw = p.string('text');
    const content = casing === 'upper' ? raw.toUpperCase() : casing === 'lower' ? raw.toLowerCase() : raw;
    const layout = layoutText(face, content, {
      size: p.number('size'),
      lineHeight: p.number('lineHeight'),
      tracking: p.number('tracking'),
      width: p.number('width'),
      align: p.string('align') as TextAlign,
    });

    ctx.save();
    ctx.translate(p.number('x'), p.number('y'));
    ctx.rotate(degToRad(p.number('rotation')));
    const scale = p.number('scale');
    ctx.scale(scale, scale);
    ctx.globalAlpha *= opacity;
    ctx.beginPath();
    const count = reveal >= 1 ? Infinity : Math.round(reveal * characterCount(content));
    traceText(ctx, layout, 0, 0, blockTop(layout, p.string('valign') as TextVAlign), count);
    const visible = opacity > 0 && count > 0;
    const fill = p.string('fill');
    if (visible && isPainted(fill)) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    const stroke = p.string('stroke');
    const strokeWidth = p.number('strokeWidth');
    if (visible && strokeWidth > 0 && isPainted(stroke)) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  },
};
