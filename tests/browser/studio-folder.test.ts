/**
 * M10: a studio folder outside the repo (ADR 0008). Its own rig in rigs/,
 * written in TypeScript against the built-ins by their @frame-studio/ names,
 * loads through the studio server's module service. An edit shows in the open
 * viewer without a page reload, and the render worker draws it too. A rig
 * can't take a built-in's id. The sidebar creates scenes and projects in it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { renderClient, startStudio, type TestStudio } from './studio-server';

let folder: string;
let studio: TestStudio;
let browser: Browser;

const dotRig = (fill: string) => `import type { Rig } from '@frame-studio/engine/types';
import { col, num, readParams } from '@frame-studio/rigs/parts/params';

const params = { r: num(120, 0, 1000, 'Radius.'), fill: col('${fill}', 'Fill.') };

export const dot: Rig = {
  id: 'dot',
  description: 'A plain dot, for the studio folder test.',
  params,
  draw(ctx, values) {
    const p = readParams(params, values);
    ctx.fillStyle = p.string('fill');
    ctx.beginPath();
    ctx.arc(320, 180, p.number('r'), 0, Math.PI * 2);
    ctx.fill();
  },
};
`;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-folder-'));
  mkdirSync(join(folder, 'scenes'));
  mkdirSync(join(folder, 'rigs'));
  writeFileSync(join(folder, 'rigs/dot.ts'), dotRig('#e05a4f'));
  writeFileSync(
    join(folder, 'scenes/dot-test.json'),
    JSON.stringify({ id: 'dot-test', fps: 12, duration: 1, size: [640, 360], seed: 1, background: { rig: 'paper', params: { tone: '#f4efe6' } }, layers: [{ id: 'dot', rig: 'dot' }] }),
  );
  // HMR on, as in the other tests that click the viewer: without it Vite's client fails its socket and trips the boot guard.
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

/** The viewer canvas's colour at the middle of the stage. */
const middle = (page: Page) =>
  page.evaluate(() => {
    const canvas = (window as unknown as { studio: { canvas: HTMLCanvasElement } }).studio.canvas;
    const [r, g, b] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return `${r},${g},${b}`;
  });

describe('a studio folder', () => {
  it("reloads an edited rig in the open viewer without a page reload, and the render worker draws it too", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(studio.paired('?scene=dot-test&frame=0'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 12);
    expect(await page.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors)).toEqual([]);
    await expect.poll(() => middle(page)).toBe('224,90,79');
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    const worker = await renderClient(studio, 'dot-test');
    const before = await worker.call('pixelHash', 0);

    writeFileSync(join(folder, 'rigs/dot.ts'), dotRig('#3355ff'));
    await expect.poll(() => middle(page), { timeout: 15_000 }).toBe('51,85,255');
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    await expect.poll(() => worker.call('pixelHash', 0), { timeout: 15_000 }).not.toBe(before);
    await page.close();
  });

  it("refuses a rig that takes a built-in's id", async () => {
    writeFileSync(join(folder, 'rigs/paper.ts'), dotRig('#000000').replace("id: 'dot'", "id: 'paper'").replace('export const dot', 'export const paper2'));
    const page = await browser.newPage();
    try {
      await page.goto(studio.paired('?scene=dot-test'));
      await page.waitForFunction(() => (window as unknown as { studio?: unknown }).studio !== undefined);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors.join('\n')), { timeout: 15_000 })
        .toMatch(/duplicate rig id "paper"/);
    } finally {
      rmSync(join(folder, 'rigs/paper.ts'), { force: true });
      await page.close();
    }
  });

  it('creates a scene and a composition from the sidebar, opens each with a new thread, and links a scene to where it is used', async () => {
    type W = { studio: { frameCount: number; scene: { id: string; fps: number; size: number[] } | null; selection: unknown; errors: string[] } };
    const read = (path: string) => JSON.parse(readFileSync(join(folder, path), 'utf8'));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(studio.paired('?scene=dot-test'));
      await page.waitForFunction(() => (window as unknown as W).studio?.frameCount === 12);
      // A folder with no compositions still offers to make one.
      expect(await page.getByText('No compositions yet.', { exact: false }).isVisible()).toBe(true);

      await page.getByRole('button', { name: 'New scene', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'New scene' });
      await dialog.getByLabel('Name').fill('Opening Shot');
      expect(await dialog.getByText('Saved as scenes/opening-shot.json').isVisible()).toBe(true);
      await dialog.getByText('Square').click();
      await dialog.getByText('30 fps').click();
      await dialog.getByRole('button', { name: 'Create' }).click();
      await page.waitForFunction(() => (window as unknown as W).studio.scene?.id === 'opening-shot');
      expect(await page.evaluate(() => (window as unknown as W).studio.scene)).toMatchObject({ fps: 30, size: [1080, 1080] });
      expect(read('scenes/opening-shot.json')).toMatchObject({ id: 'opening-shot', fps: 30, size: [1080, 1080], duration: 5, background: { rig: 'paper' }, layers: [] });
      await page.getByRole('heading', { name: 'What goes in this scene?' }).waitFor();

      // A taken name is refused in the dialog, and Escape closes it without reaching the viewer.
      await page.getByRole('button', { name: 'New scene', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'New scene' });
      await dialog.getByLabel('Name').fill('dot-test');
      await dialog.getByRole('button', { name: 'Create' }).click();
      expect(await dialog.getByRole('alert').textContent()).toMatch(/already a scene "dot-test"/);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => (window as unknown as W).studio.scene?.id)).toBe('opening-shot');

      await page.getByRole('button', { name: 'New composition' }).click();
      dialog = page.getByRole('dialog', { name: 'New composition' });
      await dialog.getByLabel('Name').fill('Short film');
      expect(await dialog.getByText('Saved as compositions/short-film.json, with one empty track.').isVisible()).toBe(true);
      await dialog.getByText('12 fps').click();
      await dialog.getByRole('button', { name: 'Create' }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get('scene') === 'short-film');
      expect(read('compositions/short-film.json')).toEqual({ id: 'short-film', fps: 12, duration: 10, size: [1920, 1080], background: '#000000', tracks: [{ id: 'V1', clips: [] }] });

      // A clip of dot-test, and dot-test then says where it's used (ADR 0013).
      writeFileSync(
        join(folder, 'compositions/short-film.json'),
        JSON.stringify({ ...read('compositions/short-film.json'), tracks: [{ id: 'V1', clips: [{ id: 'dot', scene: 'dot-test', start: 1 }] }] }),
      );
      await page.waitForFunction(() => (window as unknown as { studio: { scene: { layers: { id: string }[] } | null } }).studio.scene?.layers.some((l) => l.id === 'dot'));
      await page.getByRole('button', { name: 'dot-test', exact: true }).click();
      await page.waitForFunction(() => (window as unknown as W).studio.scene?.id === 'dot-test');
      await page.getByRole('button', { name: 'short-film', exact: true }).last().click();
      await page.waitForFunction(() => (window as unknown as W).studio.scene?.id === 'short-film');
      expect(await page.evaluate(() => (window as unknown as W).studio.errors)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
