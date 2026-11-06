/**
 * Measured checks through the real render worker (src/export/check.ts): a
 * scene built to break most of them, a composition with a gap in it, and the
 * Check video button in the viewer. The folder is temporary, so the report in
 * .frame-studio/checks/ lands there.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckReport } from '../../src/export/check';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

const FPS = 24;
const SIZE = [640, 360];
/** A rect over the whole frame. */
const cover = { x: 320, y: 180, width: SIZE[0], height: SIZE[1], stroke: 'none', strokeWidth: 0, wobble: 0 };

/**
 * Six seconds: a ball moves for one, the frame flashes black and white on every frame for one, nothing moves
 * for 2.5 (with a marker on no sound in it), the ball moves again, and five black frames sit near the end.
 */
const broken = {
  id: 'broken',
  fps: FPS,
  duration: 6,
  size: SIZE,
  seed: 1,
  background: { rig: 'paper', params: { tone: '#808080' } },
  layers: [
    {
      id: 'ball',
      rig: 'circle',
      params: { y: 180, radius: 60, fill: '#d04030' },
      tracks: [{ param: 'x', keys: [{ t: 0, v: 80 }, { t: 1, v: 320 }, { t: 4.5, v: 320 }, { t: 6, v: 560 }] }],
    },
    {
      id: 'flash',
      rig: 'rect',
      params: { ...cover, opacity: 0 },
      tracks: [
        {
          param: 'fill',
          keys: [...Array.from({ length: FPS }, (_, i) => ({ t: 1 + i / FPS, v: i % 2 === 0 ? '#000000' : '#ffffff' })), { t: 2, v: '#000000' }],
        },
      ],
      overrides: [
        { from: FPS, to: 2 * FPS, params: { opacity: 1 } },
        { from: 130, to: 135, params: { opacity: 1 } },
      ],
    },
  ],
  audio: [
    { id: 'one', generator: 'hit', start: 1, end: 1.25, params: { gain: 0.8 } },
    { id: 'two', generator: 'hit', start: 4.5, end: 4.75, params: { gain: 0.8 } },
  ],
  markers: [
    { t: 1, label: 'hit!' },
    { t: 2, label: 'just a note' },
    { t: 3, label: 'boom!' },
  ],
};

/** Moves throughout, with a pad, so nothing about it stands out. */
const calm = {
  id: 'calm',
  fps: FPS,
  duration: 2,
  size: SIZE,
  seed: 2,
  background: { rig: 'paper' },
  layers: [{ id: 'bar', rig: 'rect', params: { y: 180, width: 300, height: 200, fill: '#2060a0' }, tracks: [{ param: 'x', keys: [{ t: 0, v: 160 }, { t: 2, v: 480 }] }] }],
};

/** Two seconds of calm, then a second with nothing on the track. */
const gap = { id: 'gap', fps: FPS, duration: 3, size: SIZE, background: '#000000', tracks: [{ id: 'V1', clips: [{ id: 'one', scene: 'calm' }] }] };

let folder: string;
let studio: TestStudio;
let browser: Browser;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-check-'));
  mkdirSync(join(folder, 'scenes'));
  mkdirSync(join(folder, 'compositions'));
  writeFileSync(join(folder, 'scenes/broken.json'), JSON.stringify(broken));
  writeFileSync(join(folder, 'scenes/calm.json'), JSON.stringify(calm));
  writeFileSync(join(folder, 'compositions/gap.json'), JSON.stringify(gap));
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

const check = async (id: string, options?: { from?: number | string; to?: number | string; loop?: boolean }) => (await studio.server.workspace()).check(id, options);
const result = (report: CheckReport, id: string) => report.checks.find((c) => c.id === id);

describe('check', () => {
  let report: CheckReport & { file: string };

  beforeAll(async () => {
    report = await check('broken');
  });

  it('fails the flashing and the marker with no sound, and says where', () => {
    expect(report.ok).toBe(false);
    const flashing = result(report, 'flashing')!;
    expect(flashing.status).toBe('fail');
    expect(flashing.frames).toHaveLength(1);
    expect(flashing.frames![0][0]).toBeGreaterThanOrEqual(FPS - 1);
    expect(flashing.frames![0][0]).toBeLessThanOrEqual(FPS + 2);
    expect(flashing.frames![0][1]).toBeGreaterThanOrEqual(2 * FPS - 2);
    expect(flashing.frames![0][1]).toBeLessThanOrEqual(2 * FPS + 2);
    expect(result(report, 'markers')).toMatchObject({ status: 'fail', frames: [[72, 73]], value: 1 });
  });

  // The ball's key at 4.5 s is still 320, so frame 108 matches the frames before it, and the run ends at 109.
  it('warns on the freeze, the black frames and the silence between sounds', () => {
    expect(result(report, 'freeze')).toMatchObject({ status: 'warn', frames: [[48, 109]], value: 2.54 });
    expect(result(report, 'black')).toMatchObject({ status: 'warn' });
    expect(result(report, 'black')!.frames).toContainEqual([130, 135]);
    const dropouts = result(report, 'dropouts')!;
    expect(dropouts.status).toBe('warn');
    expect(dropouts.value).toBeGreaterThan(2.9);
    expect(dropouts.frames![0][1]).toBe(108);
  });

  it('measures the rendered sound', () => {
    expect(result(report, 'loudness')!.value).toEqual(expect.any(Number));
    expect(result(report, 'loudness')!.value).toBeLessThan(0);
    expect(result(report, 'true-peak')!.value).toBeLessThanOrEqual(1);
  });

  it('passes what is fine', () => {
    for (const id of ['format', 'duration', 'opening', 'sparse']) expect(result(report, id)?.status, id).toBe('pass');
  });

  it('saves the report', () => {
    expect(report.file).toBe(join('.frame-studio', 'checks', 'broken.json'));
    const { file: _, ...saved } = report;
    expect(JSON.parse(readFileSync(join(folder, report.file), 'utf8'))).toEqual(saved);
  });

  it('takes a range, as frames or timecodes, and shifts what it finds', async () => {
    const part = await check('broken', { from: '00:02:00', to: 120 });
    expect(part).toMatchObject({ from: 48, to: 120 });
    expect(result(part, 'flashing')?.status).toBe('pass');
    expect(result(part, 'freeze')?.frames).toEqual([[48, 109]]);
    expect(result(part, 'opening')?.message).toMatch(/^Skipped/);
    expect(result(part, 'markers')?.frames).toEqual([[72, 73]]);
  });

  it('judges the loop seam only when asked', async () => {
    const loose = await check('calm');
    expect(result(loose, 'loop-seam')?.status).toBe('pass');
    expect(result(loose, 'loop-seam')?.value).toBeGreaterThan(0.01);
    expect(result(await check('calm', { loop: true }), 'loop-seam')?.status).toBe('warn');
  });

  it('checks a composition: the gap after its clip is black', async () => {
    const edit = await check('gap');
    expect(result(edit, 'black')).toMatchObject({ status: 'warn', frames: [[48, 72]], value: 1 });
    expect(existsSync(join(folder, '.frame-studio/checks/gap.json'))).toBe(true);
  });

  it('reports progress and can be cancelled', async () => {
    const seen: { stage: string; done: number; total: number }[] = [];
    await studio.server.pool.call('calm', 'check', [{}], { onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toMatchObject({ stage: 'checking frames', done: 48, total: 48 });

    const abort = new AbortController();
    const long = studio.server.pool.call('broken', 'check', [{}], { signal: abort.signal, onProgress: () => abort.abort() });
    await expect(long).rejects.toThrow('Cancelled.');
  });

  it('names an unknown scene instead of writing anything', async () => {
    await expect(check('nope')).rejects.toThrow(/nope/);
    expect(existsSync(join(folder, '.frame-studio/checks/nope.json'))).toBe(false);
  });
});

describe('Check video in the Export panel', () => {
  it('runs a check, lists the results worst first, and seeks to one', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(studio.paired('?scene=broken&frame=0'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 144);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Check' });
    await panel.getByRole('button', { name: 'Check video' }).click();
    await expect.poll(() => panel.getByRole('status').textContent(), { timeout: 60_000 }).toMatch(/^2 failures, \d warnings?\.$/);
    const items = panel.getByRole('list', { name: 'Check results' }).getByRole('listitem');
    expect(await items.first().textContent()).toMatch(/^Fail/);
    expect(await items.last().textContent()).toMatch(/^Pass/);
    await panel.getByRole('button', { name: /^Fail\s*Sync markers/ }).click();
    await expect.poll(() => page.getByRole('status', { name: 'Frame number' }).textContent()).toBe('frame 72 of 144');
    await page.close();
  });
});
