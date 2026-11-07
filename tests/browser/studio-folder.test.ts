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
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New scene' }).click();
      let dialog = page.getByRole('dialog', { name: 'New scene' });
      await dialog.getByLabel('Name').fill('Opening Shot');
      expect(await dialog.getByText('Saved as scenes/opening-shot.json').isVisible()).toBe(true);
      await dialog.getByText('Square').click();
      await dialog.getByRole('button', { name: 'Create' }).click();
      await page.waitForFunction(() => (window as unknown as W).studio.scene?.id === 'opening-shot');
      expect(await page.evaluate(() => (window as unknown as W).studio.scene)).toMatchObject({ fps: 30, size: [1080, 1080] });
      expect(read('scenes/opening-shot.json')).toMatchObject({ id: 'opening-shot', fps: 30, size: [1080, 1080], duration: 10, background: { rig: 'paper' }, layers: [] });
      await page.getByRole('heading', { name: 'What goes in this scene?' }).waitFor();

      // A taken name is refused in the dialog, and Escape closes it without reaching the viewer.
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New scene' }).click();
      dialog = page.getByRole('dialog', { name: 'New scene' });
      await dialog.getByLabel('Name').fill('dot-test');
      await dialog.getByRole('button', { name: 'Create' }).click();
      expect(await dialog.getByRole('alert').textContent()).toMatch(/already a scene "dot-test"/);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => (window as unknown as W).studio.scene?.id)).toBe('opening-shot');

      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New video' }).click();
      dialog = page.getByRole('dialog', { name: 'New video' });
      await dialog.getByLabel('Name').fill('Short film');
      expect(await dialog.getByText('Saved as compositions/short-film.json, with scenes/short-film-1.json on its track.').isVisible()).toBe(true);
      await dialog.getByText('Start with an empty scene').click();
      expect(await dialog.getByText('Saved as compositions/short-film.json, with one empty track.').isVisible()).toBe(true);
      await dialog.getByText('Custom').click();
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

  it('makes a pixel short as a video with a pixel scene on its track', async () => {
    const read = (path: string) => JSON.parse(readFileSync(join(folder, path), 'utf8'));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(studio.paired('?scene=dot-test'));
      await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 12);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New video' }).click();
      const dialog = page.getByRole('dialog', { name: 'New video' });
      await dialog.getByLabel('Name').fill('Bread');
      await dialog.getByText('Pixel short').click();
      await dialog.getByText('Harbour').click();
      await dialog.getByRole('button', { name: 'Create' }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get('scene') === 'bread');
      const scene = read('scenes/bread-1.json');
      expect(scene).toMatchObject({ fps: 30, duration: 40, size: [1080, 1920], pixel: { scale: 6, dither: 0.5 } });
      expect(scene.pixel.palette).toHaveLength(16);
      expect(read('compositions/bread.json')).toMatchObject({ fps: 30, duration: 40, size: [1080, 1920], tracks: [{ id: 'V1', clips: [{ id: 'clip-1', scene: 'bread-1' }] }] });
      await page.getByRole('heading', { name: 'What goes in this video?' }).waitFor();
      expect(await page.evaluate(() => document.querySelector('.stage-canvas')?.classList.contains('is-pixel'))).toBe(true);
      // A guide for the platforms' interfaces, shown over a 9:16 video and never in the canvas.
      expect(await page.locator('.safe-zones').isVisible()).toBe(false);
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await page.getByRole('button', { name: 'Safe zones' }).click();
      expect(await page.locator('.safe-zones').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('moves and trims a clip on the timeline, through the checked edit, and locks it while an agent works there', async () => {
    const read = (path: string) => JSON.parse(readFileSync(join(folder, path), 'utf8'));
    writeFileSync(
      join(folder, 'compositions/cut.json'),
      JSON.stringify({ id: 'cut', fps: 12, duration: 4, size: [640, 360], tracks: [{ id: 'V1', clips: [{ id: 'one', scene: 'dot-test', start: 1 }] }], markers: [{ t: 2, label: 'beat' }] }),
    );
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(studio.paired('?scene=cut'));
      await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 48);
      await page.locator('.marker button', { hasText: 'beat' }).waitFor();
      const band = page.getByRole('group', { name: 'Shots' }).getByRole('button');
      const ruler = (await page.locator('.ruler').boundingBox())!;
      const perFrame = ruler.width / 48;
      const start = (await band.boundingBox())!;

      await page.mouse.move(start.x + start.width / 2, start.y + 8);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + perFrame * 6, start.y + 8, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => read('compositions/cut.json').tracks[0].clips[0].start).toBe(1.5);

      await page.waitForFunction(() => (window as unknown as { studio: { shots: { from: number }[] } }).studio.shots[0].from === 18);
      const moved = (await band.boundingBox())!;
      await page.mouse.move(moved.x + moved.width - 2, moved.y + 8);
      await page.mouse.down();
      await page.mouse.move(moved.x + moved.width - 2 - perFrame * 3, moved.y + 8, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => read('compositions/cut.json').tracks[0].clips[0].out).toBe(0.75);

      // The range handles work the same way on the ruler, and dragging one back clears the range.
      const handle = (await page.getByRole('button', { name: 'Range start' }).boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(ruler.x + perFrame * 12, handle.y + handle.height / 2, { steps: 3 });
      await page.mouse.up();
      expect(await page.evaluate(() => (window as unknown as { studio: { range: unknown } }).studio.range)).toEqual({ from: 12, to: 48 });

      // Command-Z takes the clip edits back, newest first, and Shift puts them back.
      const clip = () => read('compositions/cut.json').tracks[0].clips[0];
      await page.keyboard.press('Meta+z');
      await expect.poll(() => clip().out).toBeUndefined();
      await expect.poll(() => page.evaluate(() => (window as unknown as { studio: { shots: { to: number }[] } }).studio.shots[0].to)).toBe(30);
      await page.keyboard.press('Meta+z');
      await expect.poll(() => clip().start).toBe(1);
      await page.keyboard.press('Meta+Shift+z');
      await expect.poll(() => clip().start).toBe(1.5);
      await page.keyboard.press('Meta+Shift+z');
      await expect.poll(() => clip().out).toBe(0.75);

      // While an agent works there it does nothing.
      const claimed = await studio.server.queue.create({ selection: { sceneId: 'cut', from: 0, to: 48 }, frame: 0, prompt: 'cut it', references: [] });
      await studio.server.queue.claim(claimed.id, 'test-session');
      await page.waitForFunction(() => !document.querySelector('.shot-band')?.classList.contains('is-editable'));
      const refused = await fetch(`${studio.base}__studio/compositions/cut/clip`, {
        method: 'POST',
        headers: { ...studio.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clip: 'one', start: 0, in: 0, out: null }),
      });
      expect(refused.status).toBe(409);
      expect(read('compositions/cut.json').tracks[0].clips[0].start).toBe(1.5);
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(300);
      expect(clip().out).toBe(0.75);

      // An edit from elsewhere ends the history: its inverse is no longer known to be right.
      await studio.server.queue.complete(claimed.id, 'done', 'cut');
      await page.waitForFunction(() => document.querySelector('.shot-band')?.classList.contains('is-editable'));
      writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify({ ...read('compositions/cut.json'), markers: [{ t: 3, label: 'moved' }] }));
      await page.locator('.marker button', { hasText: 'moved' }).waitFor();
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(300);
      expect(clip().out).toBe(0.75);
    } finally {
      await page.close();
    }
  });

  it('opens on the library with nothing selected, shows what the folder holds, and goes back to a scene', async () => {
    mkdirSync(join(folder, 'out/dot-test'), { recursive: true });
    writeFileSync(join(folder, 'out/dot-test/dot-test.gif'), Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(studio.paired());
      const library = page.getByRole('region', { name: 'Library' });
      await library.waitFor();
      expect(new URL(page.url()).searchParams.get('scene')).toBeNull();
      await library.getByRole('region', { name: 'Scenes' }).getByRole('button', { name: 'dot-test', exact: true }).waitFor();
      await library.getByRole('region', { name: 'Renders' }).getByText('dot-test.gif').waitFor();
      await expect.poll(async () => (await page.request.get(`${studio.base}__studio/renders/dot-test/dot-test.gif`)).status()).toBe(200);
      expect((await page.request.get(`${studio.base}__studio/renders/..%2Fproject.json`)).status()).toBe(404);

      await library.getByRole('region', { name: 'Scenes' }).getByRole('button', { name: 'dot-test', exact: true }).click();
      await library.waitFor({ state: 'detached' });
      await page.waitForFunction(() => new URLSearchParams(location.search).get('scene') === 'dot-test');

      await page.getByRole('button', { name: 'Library' }).first().click();
      await library.waitFor();
      await library.getByRole('button', { name: 'Back to dot-test' }).click();
      await library.waitFor({ state: 'detached' });
    } finally {
      await page.close();
    }
  });
});
