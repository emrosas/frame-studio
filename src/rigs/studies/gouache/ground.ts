// PROTOTYPE gouache study: flat opaque ground with faint broad-brush texture.
import type { ParamSchema, Rig } from '../../../engine/types';
import { readParams } from '../../parts/params';
import { Brush, dryStroke } from './brush';
import { mix } from './color';

const params: ParamSchema = {
  color: { type: 'color', default: '#ffa200', description: 'Ground colour, painted flat over the whole stage.' },
  strokes: {
    type: 'number', default: 1, min: 0, max: 3,
    description: 'Density of broad, faint flat-brush strokes that break up the flat colour. 0 is a clean fill.',
  },
  texture: {
    type: 'number', default: 0.5, min: 0, max: 1,
    description: 'Strength of the lighter and darker tints in the broad strokes and grain, 0 to 1.',
  },
  grain: {
    type: 'number', default: 0.5, min: 0, max: 1,
    description: 'Density of short thin dry-brush scratches, 0 to 1.',
  },
  direction: {
    type: 'number', default: -70, min: -180, max: 180,
    description: 'Main brush direction in degrees, clockwise from pointing right. Strokes spread about 25 degrees around it.',
  },
};

const MAX_BROAD = 260;
const MAX_GRAIN = 1400;

export const gouacheGround: Rig = {
  id: 'gouache-ground',
  description:
    'PROTOTYPE gouache ground. Fills the stage with one opaque colour, then lays faint broad flat-brush strokes and ' +
    'thin dry scratches in lighter and darker tints, so the ground reads as painted rather than printed.',
  params,
  draw(ctx, values, _t, rng, stage) {
    const p = readParams(params, values);
    const color = p.string('color');
    const texture = p.number('texture');
    const { width, height } = stage;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);

    const brush = new Brush({ minX: 0, minY: 0, maxX: width, maxY: height });
    const size = Math.max(width, height);
    const units = (width * height) / 10000;
    const base = (p.number('direction') * Math.PI) / 180;
    const light = mix(color, '#ffffff', 0.35);
    const dark = mix(color, '#b04000', 0.35);

    const broad = rng.fork('broad');
    const nBroad = Math.min(MAX_BROAD, Math.round(p.number('strokes') * units * 0.06));
    for (let i = 0; i < nBroad; i++) {
      const cx = broad.range(-0.1, 1.1) * width;
      const cy = broad.range(-0.1, 1.1) * height;
      const a = base + broad.range(-0.45, 0.45);
      const len = size * broad.range(0.12, 0.4);
      const dx = (Math.cos(a) * len) / 2;
      const dy = (Math.sin(a) * len) / 2;
      const bend = broad.range(-0.08, 0.08) * len;
      dryStroke(brush, broad, {
        x0: cx - dx, y0: cy - dy,
        cx: cx - Math.sin(a) * bend, cy: cy + Math.cos(a) * bend,
        x1: cx + dx, y1: cy + dy,
        width: size * broad.range(0.03, 0.08),
        bristles: broad.int(7, 12),
        color: broad.next() < 0.55 ? light : dark,
        alpha: texture * broad.range(0.05, 0.12),
        gaps: 0.8,
      });
    }
    brush.flush(ctx);

    const grain = rng.fork('grain');
    const nGrain = Math.min(MAX_GRAIN, Math.round(p.number('grain') * units * 1.6));
    for (let i = 0; i < nGrain; i++) {
      const cx = grain.range(0, width);
      const cy = grain.range(0, height);
      const a = base + grain.range(-0.3, 0.3);
      const len = size * grain.range(0.008, 0.03);
      const dx = (Math.cos(a) * len) / 2;
      const dy = (Math.sin(a) * len) / 2;
      dryStroke(brush, grain, {
        x0: cx - dx, y0: cy - dy, cx, cy, x1: cx + dx, y1: cy + dy,
        width: size * grain.range(0.001, 0.003),
        bristles: 1,
        color: grain.next() < 0.5 ? light : dark,
        alpha: texture * grain.range(0.15, 0.4),
        gaps: 0.6,
      });
    }
    brush.flush(ctx);
  },
};
