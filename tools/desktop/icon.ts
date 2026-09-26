// The app icon, drawn in code like everything else: four white viewfinder
// corners around an orange dot, on a black squircle. `writeIcon(dir)` writes
// icon.png (1024 px) and, on macOS, icon.icns; npm run desktop:build and
// npm run desktop call it. Run alone, it writes them to build/desktop/.
//
// The body follows Apple's macOS icon grid: an 824 px squircle inset 100 px
// in a 1024 px canvas, corner radius 185.4 with 60% corner smoothing (the
// "continuous corner"), so it sits in the Dock like other apps' icons.

import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { REPO } from '../studio/folder.ts';

/** The brand accent. The viewer's --accent is the same colour. */
export const ACCENT = '#ff5a1f';

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * An SVG path for a square of side `size` at (x, y) with smoothed corners of radius `r`: each corner is a
 * circular arc eased into the straight edge by two cubics, after Figma's corner smoothing.
 */
export function squirclePath(x: number, y: number, size: number, r: number, smoothing = 0.6): string {
  const p = (1 + smoothing) * r;
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const beta = 45 * smoothing;
  const c = r * Math.tan(rad(alpha / 2)) * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const s = size;
  const n = (v: number) => Number(v.toFixed(3));
  return [
    `M ${n(x + s - p)} ${n(y)}`,
    `c ${n(a)} 0 ${n(a + b)} 0 ${n(a + b + c)} ${n(d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c ${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(a + b + c)}`,
    `L ${n(x + s)} ${n(y + s - p)}`,
    `c 0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(a + b + c)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c ${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-(a + b + c))} ${n(d)}`,
    `L ${n(x + p)} ${n(y + s)}`,
    `c ${n(-a)} 0 ${n(-(a + b))} 0 ${n(-(a + b + c))} ${n(-d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c ${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-(a + b + c))}`,
    `L ${n(x)} ${n(y + p)}`,
    `c 0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-(a + b + c))}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c ${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(a + b + c)} ${n(-d)}`,
    'Z',
  ].join(' ');
}

/** The icon at `px` pixels square, as a PNG. Drawn on the 1024 grid and scaled. */
export function drawIcon(px: number): Buffer {
  const canvas = createCanvas(px, px);
  const ctx = canvas.getContext('2d');
  ctx.scale(px / 1024, px / 1024);
  const body = new Path2D(squirclePath(100, 100, 824, 185.4));

  // The drop shadow macOS icons carry, then the body: near-black, a shade lighter at the top.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  const fill = ctx.createLinearGradient(0, 100, 0, 924);
  fill.addColorStop(0, '#222224');
  fill.addColorStop(1, '#070707');
  ctx.fillStyle = fill;
  ctx.fill(body);
  ctx.restore();
  // A hairline edge, lit from above, so the body reads on a dark Dock.
  ctx.save();
  ctx.clip(body);
  const edge = ctx.createLinearGradient(0, 100, 0, 924);
  edge.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  edge.addColorStop(0.5, 'rgba(255, 255, 255, 0.06)');
  edge.addColorStop(1, 'rgba(255, 255, 255, 0.1)');
  ctx.strokeStyle = edge;
  ctx.lineWidth = 6;
  ctx.stroke(body);
  ctx.restore();

  // The viewfinder: four corners framing a 500 px square.
  ctx.strokeStyle = '#f5f5f4';
  ctx.lineWidth = 46;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lo = 262;
  const hi = 762;
  const arm = 146;
  for (const [x, y, dx, dy] of [
    [lo, lo, 1, 1],
    [hi, lo, -1, 1],
    [lo, hi, 1, -1],
    [hi, hi, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * arm);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * arm, y);
    ctx.stroke();
  }

  // The subject: the accent dot, with a soft light from the top left.
  const dot = ctx.createRadialGradient(470, 470, 10, 512, 512, 118);
  dot.addColorStop(0, '#ff7a45');
  dot.addColorStop(1, ACCENT);
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(512, 512, 114, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

/** Writes icon.png and, on macOS, icon.icns into `dir`. Returns their paths. */
export async function writeIcon(dir: string): Promise<{ png: string; icns: string | null }> {
  await mkdir(dir, { recursive: true });
  const png = join(dir, 'icon.png');
  await writeFile(png, drawIcon(1024));
  if (process.platform !== 'darwin') return { png, icns: null };
  // Each size drawn from the vectors, not downscaled from 1024, so the small ones stay crisp.
  const set = join(dir, 'icon.iconset');
  await rm(set, { recursive: true, force: true });
  await mkdir(set);
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(set, `icon_${size}x${size}.png`), drawIcon(size));
    await writeFile(join(set, `icon_${size}x${size}@2x.png`), drawIcon(size * 2));
  }
  const icns = join(dir, 'icon.icns');
  const made = spawnSync('iconutil', ['-c', 'icns', set, '-o', icns], { encoding: 'utf8' });
  await rm(set, { recursive: true, force: true });
  if (made.status !== 0) throw new Error(`iconutil failed: ${made.stderr}`);
  return { png, icns };
}

if (import.meta.main) {
  const out = await writeIcon(join(REPO, 'build/desktop'));
  process.stdout.write(`${out.png}\n${out.icns ?? ''}\n`);
}
