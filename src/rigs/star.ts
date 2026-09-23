import { resampleLoop, type Point } from './parts/outline';
import { defineShapeRig } from './parts/shape';

export const star = defineShapeRig({
  id: 'star',
  description:
    'A star centred on (x, y) with its first tip pointing up. Tips sit on outerRadius and the notches between them on innerRadius. ' +
    'Set wobble above 0 for a hand-drawn outline that boils.',
  fill: '#f2b134',
  params: {
    points: {
      type: 'number',
      default: 5,
      min: 3,
      max: 24,
      description: 'Number of tips. Rounded to a whole number, so a track on it steps from one count to the next.',
    },
    outerRadius: {
      type: 'number',
      default: 110,
      min: 0,
      max: 5000,
      description: 'Distance from the centre to each tip, in scene pixels at scale 1.',
    },
    innerRadius: {
      type: 'number',
      default: 48,
      min: 0,
      max: 5000,
      description: 'Distance from the centre to each notch, in scene pixels at scale 1.',
    },
  },
  geometry(p) {
    const vertices = starVertices(p.integer('points'), p.number('outerRadius'), p.number('innerRadius'));
    return {
      trace(ctx) {
        vertices.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
        ctx.closePath();
      },
      sample: () => resampleLoop(vertices),
    };
  },
});

/** Tips and notches alternating clockwise, starting with the top tip. */
function starVertices(points: number, outerRadius: number, innerRadius: number): Point[] {
  const vertices: Point[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    vertices.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, corner: true });
  }
  return vertices;
}
