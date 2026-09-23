import { TAU } from './parts/math';
import { sampleCircle } from './parts/outline';
import { defineShapeRig } from './parts/shape';

export const circle = defineShapeRig({
  id: 'circle',
  description: 'A circle centred on (x, y). Set wobble above 0 for a hand-drawn outline that boils.',
  fill: '#e05a4f',
  params: {
    radius: { type: 'number', default: 80, min: 0, max: 5000, description: 'Radius in scene pixels at scale 1.' },
  },
  geometry(p) {
    const radius = p.number('radius');
    return {
      trace: (ctx) => ctx.arc(0, 0, radius, 0, TAU),
      sample: () => sampleCircle(radius),
    };
  },
});
