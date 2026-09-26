/**
 * M9 in a real browser: the sample project, projects/bears-story (ADR 0007).
 *
 * - The film draws a shot showing in full pixel for pixel as the shot draws
 *   alone, and seeking draws the same pixels as playing.
 * - Its MP4 carries the shots' sound, shifted and trimmed: the blip at the cut
 *   lands within one frame, a blip the trim cuts off is gone, and the music
 *   bed ducks under the second shot.
 * - It exports to GIF, and to one HTML file that carries the placed shots, the
 *   project's iris rig and the cast, makes no requests, and draws the same
 *   pixels as the render page.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbedApi } from '../../src/embed/player';
import { readGifStructure } from '../../src/export/testing/gif-structure';
import { buildEmbed } from '../../tools/bundle/embed';
import { launchBrowser, openStudio, type Studio } from '../../tools/render/studio';

const FILM = 'bears-story/film';
const SPF = 48000 / 12;

let browser: Browser;
let studio: Studio;
let dir: string;

beforeAll(async () => {
  browser = await launchBrowser();
  studio = await openStudio(FILM, { browser });
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-projects-'));
});

afterAll(async () => {
  await studio?.close();
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The file's audio as ffmpeg decodes it, through `filter`: mono float samples at 48 kHz. */
function decodeAudio(path: string, filter: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-ac', '1', '-ar', '48000', '-af', filter, '-f', 'f32le', '-'], {
    maxBuffer: 1 << 28,
  });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

const peak = (samples: Float32Array, from: number, to: number) => samples.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (samples: Float32Array, from: number, to: number) => Math.sqrt(samples.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

describe('the film', () => {
  it('draws a shot showing in full exactly as the shot draws alone', async () => {
    // [shot, film frame, shot frame]: meet from 0, pip from 3 s, together from 6 s, all untrimmed at these frames.
    const pairs: [string, number, number][] = [
      ['bears-story/meet', 0, 0],
      ['bears-story/meet', 30, 30],
      ['bears-story/pip', 36, 0],
      ['bears-story/pip', 66, 30],
      ['bears-story/together', 84, 12],
      ['bears-story/together', 119, 47],
    ];
    await studio.load(FILM);
    const film = new Map<number, string>();
    for (const [, f] of pairs) film.set(f, await studio.call('pixelHash', f));
    for (const [shot, f, g] of pairs) {
      await studio.load(shot);
      expect(await studio.call('pixelHash', g), `${shot} frame ${g} in film frame ${f}`).toBe(film.get(f));
    }
  });

  it('draws the same pixels seeked to as played to, through the crossfade and the iris', async () => {
    const frames = [70, 72, 78, 84, 118, 120, 126, 131, 132, 143];
    await studio.load(FILM);
    const played: string[] = [];
    for (let f = 60; f <= 143; f++) {
      const hash = await studio.call('pixelHash', f);
      if (frames.includes(f)) played.push(hash);
    }
    await studio.load(FILM);
    const seeked: string[] = [];
    for (const f of [...frames].reverse()) seeked.unshift(await studio.call('pixelHash', f));
    expect(seeked).toEqual(played);
    // The crossfade and the iris are neither shot alone.
    expect(new Set(played).size).toBe(frames.length);
  });
});

describe('the film MP4', () => {
  let path: string;
  beforeAll(async () => {
    await studio.load(FILM);
    path = join(dir, 'film.mp4');
    const result = await studio.call('exportVideo', 'mp4', await studio.fileSink(path));
    expect(result).toMatchObject({ frames: 144, seconds: 12 });
    expect(result.audioCodec).toBeDefined();
  });

  it.skipIf(!hasFfmpeg())("puts a shot's blip at the cut within one frame, and leaves out a blip the trim cut off (dev only)", () => {
    // Above the bed, which is muffled below 600 Hz: only the blips pass.
    const blips = decodeAudio(path, 'highpass=f=750,highpass=f=750');
    const onsetAfter = (from: number) => {
      for (let i = Math.max(0, from); i < blips.length; i++) if (Math.abs(blips[i]) > 0.05) return i;
      return -1;
    };
    // pip's blip on its first frame, at the 3 s cut; meet's second blip, 2 s into meet, placed again from 1 s at 10 s.
    for (const expected of [3 * 48000, 11 * 48000]) {
      const onset = onsetAfter(expected - SPF);
      expect(onset - expected, `blip at ${expected / 48000} s`).toBeGreaterThanOrEqual(0);
      expect(onset - expected, `blip at ${expected / 48000} s`).toBeLessThan(SPF);
    }
    // meet's first blip is before the trim's in point, so nothing sounds when it comes back at 10 s.
    expect(peak(blips, 10 * 48000, 10.9 * 48000)).toBeLessThan(0.05);
  });

  it.skipIf(!hasFfmpeg())('ducks the music bed under the second shot (dev only)', () => {
    const bed = decodeAudio(path, 'lowpass=f=400,lowpass=f=400');
    const full = rms(bed, 1.2 * 48000, 2.8 * 48000);
    const ducked = rms(bed, 4 * 48000, 6 * 48000);
    expect(full).toBeGreaterThan(0.005);
    expect(ducked / full).toBeLessThan(0.5);
  });

  it('exports to GIF with every frame', async () => {
    const gif = join(dir, 'film.gif');
    const result = await studio.call('exportVideo', 'gif', await studio.fileSink(gif), { from: 0, to: 24 });
    expect(result.frames).toBe(24);
    expect(readGifStructure(readFileSync(gif)).frames).toHaveLength(24);
  });
});

describe('the film embed', () => {
  it('carries the shots, the iris rig and the cast, makes no requests, and matches the render page', async () => {
    const build = await buildEmbed(FILM);
    expect(build.out).toBe('bears-story/film');
    expect(build.scenes).toEqual(['meet', 'pip', 'together']);
    expect(build.rigs).toEqual(['bear', 'iris', 'paper']);
    expect(build.generators).toEqual(['blip', 'buzz', 'pad']);
    for (const name of ['bruno', 'pip']) expect(build.html).toContain(`"${name}":{"rig":"bear"`);
    const file = join(dir, 'film.html');
    writeFileSync(file, build.html);

    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 960, height: 540 } });
    await context.setOffline(true);
    try {
      const page = await context.newPage();
      const requests: string[] = [];
      const problems: string[] = [];
      page.on('request', (r) => requests.push(r.url()));
      page.on('pageerror', (e) => problems.push(e.message));
      const url = `${pathToFileURL(file).href}?autoplay=0`;
      await page.goto(url);
      await page.waitForFunction(() => 'studio' in window);
      await studio.load(FILM);
      for (const frame of [30, 78, 126]) {
        const hash = await page.evaluate(async (f) => {
          const { studio: embed } = window as unknown as { studio: EmbedApi };
          embed.seek(f);
          const c = embed.canvas;
          const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
          return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
        }, frame);
        expect(hash, `frame ${frame}`).toBe(await studio.call('pixelHash', frame));
      }
      expect(requests).toEqual([url]);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
