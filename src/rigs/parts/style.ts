import type { Ctx2D, ParamSchema } from '../../engine/types';
import { degToRad } from './math';
import type { ParamReader } from './params';

/** Position, scale and rotation shared by every shape rig. */
export const transformParams: ParamSchema = {
  x: { type: 'number', default: 960, min: -10000, max: 10000, description: 'Centre x in scene pixels.' },
  y: { type: 'number', default: 540, min: -10000, max: 10000, description: 'Centre y in scene pixels.' },
  scale: {
    type: 'number',
    default: 1,
    min: 0,
    max: 20,
    description: 'Uniform scale about the centre. Stroke width and wobble scale with the shape.',
  },
  rotation: {
    type: 'number',
    default: 0,
    min: -36000,
    max: 36000,
    description: 'Rotation in degrees, clockwise on screen.',
  },
};

/** Fill, outline, opacity and hand-drawn wobble shared by every shape rig. */
export function styleParams(defaultFill: string): ParamSchema {
  return {
    fill: {
      type: 'color',
      default: defaultFill,
      description: 'Fill colour, any CSS colour string. "none" skips the fill.',
    },
    stroke: {
      type: 'color',
      default: '#2b2b2b',
      description: 'Outline colour, any CSS colour string. "none" skips the outline.',
    },
    strokeWidth: {
      type: 'number',
      default: 6,
      min: 0,
      max: 100,
      description: 'Outline width in scene pixels at scale 1. 0 skips the outline.',
    },
    opacity: { type: 'number', default: 1, min: 0, max: 1, description: 'Opacity of the whole shape, 0 to 1.' },
    wobble: {
      type: 'number',
      default: 0,
      min: 0,
      max: 50,
      description:
        'Hand-drawn boil: how far the outline bulges in and out, in scene pixels at scale 1. 0 draws a clean shape. ' +
        'The outline is redrawn only when the layer time changes, so the layer stepFps sets the boil rate.',
    },
  };
}

/** Moves the origin to (x, y), then rotates and scales about it. */
export function applyTransform(ctx: Ctx2D, p: ParamReader): void {
  ctx.translate(p.number('x'), p.number('y'));
  ctx.rotate(degToRad(p.number('rotation')));
  const scale = p.number('scale');
  ctx.scale(scale, scale);
}

/** Fills, then outlines, the current path with the shape style params. */
export function paintPath(ctx: Ctx2D, p: ParamReader): void {
  const opacity = p.number('opacity');
  if (opacity <= 0) return;
  ctx.globalAlpha *= opacity;

  const fill = p.string('fill');
  if (isPainted(fill)) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  const stroke = p.string('stroke');
  const strokeWidth = p.number('strokeWidth');
  if (strokeWidth > 0 && isPainted(stroke)) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/** False for "", "none" and "transparent" in any case. The canvas ignores "None", which would paint black. */
function isPainted(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c !== '' && c !== 'none' && c !== 'transparent';
}
