import type { Ctx2D } from '../engine/types';
import { clamp } from './parts/math';
import { sampleRoundedRect } from './parts/outline';
import { defineShapeRig } from './parts/shape';

export const rect = defineShapeRig({
  id: 'rect',
  description:
    'A rectangle centred on (x, y), optionally with rounded corners. Rotation turns it about its centre. ' +
    'Set wobble above 0 for a hand-drawn outline that boils.',
  fill: '#e8b04b',
  params: {
    width: { type: 'number', default: 200, min: 0, max: 10000, description: 'Width in scene pixels at scale 1.' },
    height: { type: 'number', default: 140, min: 0, max: 10000, description: 'Height in scene pixels at scale 1.' },
    cornerRadius: {
      type: 'number',
      default: 0,
      min: 0,
      max: 5000,
      description: 'Corner radius in scene pixels at scale 1, capped at half the shorter side.',
    },
  },
  geometry(p) {
    const width = p.number('width');
    const height = p.number('height');
    const radius = clamp(p.number('cornerRadius'), 0, Math.min(width, height) / 2);
    return {
      trace: (ctx) => traceRoundedRect(ctx, width, height, radius),
      sample: () => sampleRoundedRect(width, height, radius),
    };
  },
});

function traceRoundedRect(ctx: Ctx2D, width: number, height: number, radius: number): void {
  const hw = width / 2;
  const hh = height / 2;
  if (radius <= 0) {
    ctx.rect(-hw, -hh, width, height);
    return;
  }
  ctx.moveTo(-hw + radius, -hh);
  ctx.arcTo(hw, -hh, hw, hh, radius);
  ctx.arcTo(hw, hh, -hw, hh, radius);
  ctx.arcTo(-hw, hh, -hw, -hh, radius);
  ctx.arcTo(-hw, -hh, hw, -hh, radius);
  ctx.closePath();
}
