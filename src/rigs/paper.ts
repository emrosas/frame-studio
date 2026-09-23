import type { Ctx2D, ParamSchema, Rig, Rng, Stage } from '../engine/types';
import { TAU } from './parts/math';
import { readParams } from './parts/params';

const params: ParamSchema = {
  tone: { type: 'color', default: '#f4efe6', description: 'Base paper colour, any CSS colour string.' },
  grain: { type: 'number', default: 0.5, min: 0, max: 1, description: 'Density of fine specks, 0 to 1.' },
  fibres: { type: 'number', default: 0.5, min: 0, max: 1, description: 'Density of short curved paper fibres, 0 to 1.' },
  mottle: {
    type: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    description: 'Strength of large soft light and dark patches that break up the flat tone, 0 to 1.',
  },
  vignette: { type: 'number', default: 0.3, min: 0, max: 1, description: 'Darkening toward the edges, 0 to 1.' },
  boil: {
    type: 'boolean',
    default: false,
    description:
      'Off: the texture is fixed for the whole scene. On: the texture re-rolls whenever the layer time changes, ' +
      'so combine it with stepFps for boiling paper.',
  },
};

/** Warm dark and white inks laid over the tone, so the texture suits any paper colour. */
const SPECK_INKS = [
  'rgba(70, 52, 34, 0.06)',
  'rgba(70, 52, 34, 0.11)',
  'rgba(70, 52, 34, 0.18)',
  'rgba(255, 255, 255, 0.35)',
  'rgba(255, 255, 255, 0.55)',
];
const FIBRE_INKS = [
  { color: 'rgba(110, 82, 52, 0.10)', width: 0.8 },
  { color: 'rgba(110, 82, 52, 0.16)', width: 0.6 },
  { color: 'rgba(110, 82, 52, 0.06)', width: 1.6 },
  { color: 'rgba(255, 255, 255, 0.45)', width: 1 },
];
/** Scene pixels of paper per speck and per fibre at full density. */
const SPECK_AREA = 600;
const FIBRE_AREA = 5000;
const MOTTLE_PATCHES = 7;

export const paper: Rig = {
  id: 'paper',
  description:
    'Background paper. Fills the whole stage with tone, then adds seeded grain, fibres, soft mottling and a vignette ' +
    'so the page is not flat. The texture depends only on the scene seed and layer id, so it holds still from frame ' +
    'to frame unless boil is on.',
  params,
  draw(ctx, values, t, rng, stage) {
    const p = readParams(params, values);

    ctx.fillStyle = p.string('tone');
    ctx.fillRect(0, 0, stage.width, stage.height);

    const texture = p.boolean('boil') ? rng.fork(String(t)) : rng;
    drawMottle(ctx, stage, texture.fork('mottle'), p.number('mottle'));
    drawSpecks(ctx, stage, texture.fork('grain'), p.number('grain'));
    drawFibres(ctx, stage, texture.fork('fibres'), p.number('fibres'));
    drawVignette(ctx, stage, p.number('vignette'));
  },
};

function drawMottle(ctx: Ctx2D, { width, height }: Stage, rng: Rng, amount: number): void {
  if (amount <= 0) return;
  const size = Math.max(width, height);
  for (let i = 0; i < MOTTLE_PATCHES; i++) {
    const x = rng.range(0, width);
    const y = rng.range(0, height);
    const radius = rng.range(0.12, 0.35) * size;
    const rgb = rng.next() < 0.5 ? '255, 255, 255' : '120, 90, 60';
    const alpha = amount * rng.range(0.04, 0.09);
    const patch = ctx.createRadialGradient(x, y, 0, x, y, radius);
    patch.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(4)})`);
    patch.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = patch;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

function drawSpecks(ctx: Ctx2D, { width, height }: Stage, rng: Rng, amount: number): void {
  const perInk = Math.round((amount * width * height) / (SPECK_AREA * SPECK_INKS.length));
  if (perInk <= 0) return;
  for (const ink of SPECK_INKS) {
    ctx.beginPath();
    for (let i = 0; i < perInk; i++) {
      const x = rng.range(0, width);
      const y = rng.range(0, height);
      const radius = rng.range(0.5, 1.4);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, TAU);
    }
    ctx.fillStyle = ink;
    ctx.fill();
  }
}

function drawFibres(ctx: Ctx2D, { width, height }: Stage, rng: Rng, amount: number): void {
  const perInk = Math.round((amount * width * height) / (FIBRE_AREA * FIBRE_INKS.length));
  if (perInk <= 0) return;
  ctx.lineCap = 'round';
  for (const ink of FIBRE_INKS) {
    ctx.beginPath();
    for (let i = 0; i < perInk; i++) {
      const x = rng.range(0, width);
      const y = rng.range(0, height);
      const angle = rng.range(0, TAU);
      const half = rng.range(3, 15);
      const bend = rng.range(-0.7, 0.7) * half;
      const dx = Math.cos(angle) * half;
      const dy = Math.sin(angle) * half;
      // The control point sits off the fibre's midpoint, perpendicular to it.
      ctx.moveTo(x - dx, y - dy);
      ctx.quadraticCurveTo(x - Math.sin(angle) * bend, y + Math.cos(angle) * bend, x + dx, y + dy);
    }
    ctx.strokeStyle = ink.color;
    ctx.lineWidth = ink.width;
    ctx.stroke();
  }
}

function drawVignette(ctx: Ctx2D, { width, height }: Stage, amount: number): void {
  if (amount <= 0) return;
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.hypot(cx, cy);
  const shade = ctx.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer);
  shade.addColorStop(0, 'rgba(60, 42, 24, 0)');
  shade.addColorStop(1, `rgba(60, 42, 24, ${(0.4 * amount).toFixed(4)})`);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);
}
