/** PROTOTYPE watercolour study: a flat-ish wash of one colour over paper, laid in overlapping bands. */
import type { ParamSchema, Rig } from '../../../engine/types';
import { readParams } from '../../parts/params';
import { bloomRing, blooms as paintBlooms, fray, gauss, mix, paintable, ringFrom, specks, valueNoise, wash, circlePoints, type Pt, type Ring } from './wash';

const params: ParamSchema = {
  color: { type: 'color', default: '#ffa200', description: 'Wash colour.' },
  paper: { type: 'color', default: '#fefdf9', description: 'Paper colour under the wash.' },
  layers: { type: 'number', default: 12, min: 1, max: 40, description: 'Full-stage translucent wash layers.' },
  bands: {
    type: 'number',
    default: 10,
    min: 0,
    max: 30,
    description: 'Horizontal brush bands laid top to bottom, as in a flat wash. Their overlaps leave faint bead lines.',
  },
  mottle: { type: 'number', default: 0.5, min: 0, max: 1, description: 'Soft darker and paler patches from uneven drying.' },
  blooms: { type: 'number', default: 0.2, min: 0, max: 1, description: 'Number and strength of cauliflower blooms.' },
  granulation: { type: 'number', default: 0.4, min: 0, max: 1, description: 'Pigment granulation specks.' },
  tooth: { type: 'number', default: 0.5, min: 0, max: 1, description: 'Paper tooth showing through as pale specks.' },
};

export const watercolorGround: Rig = {
  id: 'watercolor-ground',
  description:
    'Watercolour ground: paper covered by a flat-ish wash of one colour, built from full-stage translucent layers ' +
    'and overlapping horizontal brush bands with ragged edges, plus soft mottling, a few blooms, granulation and paper tooth.',
  params,
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const { width: W, height: H } = stage;
    const color = p.string('color');
    const paper = p.string('paper');
    const deeper = mix(color, '#7a2a00', 80);

    ctx.fillStyle = paintable(paper) ? paper : '#fefdf9';
    ctx.fillRect(0, 0, W, H);
    if (!paintable(color)) return;

    const margin = 40;
    const rect: Pt[] = [
      [-margin, -margin],
      [W + margin, -margin],
      [W + margin, H + margin],
      [-margin, H + margin],
    ];
    const layers = p.integer('layers');
    const bands = p.integer('bands');
    // Alpha so that the full layers plus two overlapping bands at any point land near 97 percent colour.
    const alpha = 1 - Math.pow(0.03, 1 / (layers + (bands > 0 ? 2 : 0)));
    const full = fray(ringFrom(rect, 60, 120), rng.fork('full-shape'), 0.05, 2);
    wash(ctx, full, rng.fork('full'), { color, layers, alpha, spread: 20, stride: 2 });

    if (bands > 0) {
      const br = rng.fork('bands');
      const step = H / bands;
      for (let i = 0; i < bands; i++) {
        const top = i * step - step * 0.35 + gauss(br) * step * 0.08;
        const bottom = (i + 1) * step + step * 0.35 + gauss(br) * step * 0.08;
        const band: Pt[] = [
          [-margin, top],
          [W + margin, top + gauss(br) * 10],
          [W + margin, bottom],
          [-margin, bottom + gauss(br) * 10],
        ];
        const ring = fray(ringFrom(band, 40, 100), br, 0.06, 2);
        wash(ctx, ring, br, { color, layers: 2, alpha, spread: step * 0.08, bias: -0.2, stride: 2 });
      }
    }

    const mottle = p.number('mottle');
    if (mottle > 0) {
      const mr = rng.fork('mottle');
      const count = Math.round(4 + mottle * 10);
      const dark: Ring[] = [];
      const light: Ring[] = [];
      for (let i = 0; i < count; i++) {
        const r = 60 + mr.next() * 220;
        const ring = fray(ringFrom(circlePoints(mr.next() * W, mr.next() * H, r, 20), r / 6, 30), mr, 0.2, 1);
        (i % 3 !== 0 ? dark : light).push(ring);
      }
      wash(ctx, dark, mr, { color: deeper, layers: 5, alpha: 0.03 * mottle, spread: 60, bias: -0.5, composite: 'multiply' });
      wash(ctx, light, mr, { color: paper, layers: 5, alpha: 0.025 * mottle, spread: 60, bias: -0.5 });
    }

    const blooms = p.number('blooms');
    if (blooms > 0) {
      const bl = rng.fork('blooms');
      const count = Math.round(blooms * 6);
      const rings: Ring[] = [];
      for (let i = 0; i < count; i++) rings.push(bloomRing(bl, bl.next() * W, bl.next() * H, 30 + bl.next() * 70));
      paintBlooms(ctx, bl, rings, 60, paper, deeper, blooms * 0.8);
    }

    const gran = p.number('granulation');
    if (gran > 0) {
      const gr = rng.fork('granules');
      const mask = valueNoise(gr.fork('mask'), 26);
      specks(ctx, gr.fork('fine'), { x0: 0, y0: 0, x1: W, y1: H }, {
        color: deeper,
        alpha: 0.3,
        density: 2 * gran,
        size: [0.6, 1.6],
        composite: 'multiply',
        mask,
        max: 6000,
      });
    }

    const tooth = p.number('tooth');
    if (tooth > 0) {
      const tr = rng.fork('tooth');
      specks(ctx, tr, { x0: 0, y0: 0, x1: W, y1: H }, {
        color: paper,
        alpha: 0.12 + 0.2 * tooth,
        density: 1.6 * tooth,
        size: [0.7, 2],
        mask: valueNoise(tr.fork('mask'), 5),
        max: 6000,
      });
    }
  },
};
