/**
 * M16, stills (ADR 0020), on a temporary studio folder: a still made by the
 * tools and by New scene, PNG and JPG at the scene's exact size from the tools,
 * the CLI and the Export panel, check on one frame, and the viewer with its
 * timeline out of the way while select, drag and requests still work.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/scene-files';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

const run = promisify(execFile);

let folder: string;
let studio: TestStudio;
let browser: Browser;
let page: Page;

interface StudioPage {
  studio: { frameCount: number; frame: number; select(id: string | null): void; selection: { layerId?: string; from?: number; to?: number } | null };
}

const SIZE = [1080, 1350] as const;
const soon = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
const path = (file: string) => join(folder, file);
const read = (file: string) => JSON.parse(readFileSync(path(file), 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(path(file), JSON.stringify(value, null, 2));
const layerIn = (file: string, id: string) => read(file).layers.find((l: { id: string }) => l.id === id);

const dot = { id: 'dot', rig: 'circle', params: { x: 300, y: 400, radius: 120, fill: '#d04040' } };
const card = {
  id: 'card',
  fps: 1,
  duration: 1,
  size: [...SIZE],
  seed: 1,
  background: { rig: 'paper', params: { tone: '#f4efe6' } },
  layers: [dot, { id: 'title', rig: 'text', params: { text: 'Hello there', x: 540, y: 700, size: 90, align: 'center', fill: '#18191b' } }],
};
/** The same picture as an animation, to show what a still leaves out. */
const moving = { ...card, id: 'moving', fps: 12, duration: 2 };

/** Width, height and a hash of the RGBA pixels of an image file. */
async function pixels(file: string): Promise<{ width: number; height: number; hash: string; data: Uint8ClampedArray }> {
  const image = await loadImage(readFileSync(file));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, hash: createHash('sha256').update(data).digest('hex'), data };
}

async function open(scene: string, frames: number): Promise<void> {
  await page.goto(studio.paired(`?scene=${encodeURIComponent(scene)}`));
  await page.waitForFunction((n) => (window as unknown as StudioPage).studio?.frameCount === n, frames);
  await page.waitForFunction(() => !!document.querySelector('canvas.stage-canvas')?.getBoundingClientRect().width);
}

/** A point on the canvas, in scene pixels, as client pixels. */
async function onCanvas(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.stage-canvas').boundingBox())!;
  return { x: box.x + (x / SIZE[0]) * box.width, y: box.y + (y / SIZE[1]) * box.height };
}

const selection = () => page.evaluate(() => (window as unknown as StudioPage).studio.selection);
const panel = () => page.getByRole('complementary', { name: 'Agent' });

beforeAll(async () => {
  // The real path, so the CLI's paths come out relative to it.
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-stills-')));
  for (const dir of ['scenes', 'compositions']) mkdirSync(path(dir), { recursive: true });
  write('scenes/card.json', card);
  write('scenes/moving.json', moving);
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

beforeEach(async () => {
  write('scenes/card.json', card);
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
});

describe('the tools on a still', () => {
  it('creates one with still: true, as one frame at the size given', async () => {
    const w = await studio.server.workspace();
    const made = await w.createScene({ id: 'slide-1', still: true, size: [1080, 1350] });
    expect(made.scene).toMatchObject({ id: 'slide-1', fps: 1, duration: 1, size: [1080, 1350], layers: [] });
    expect(read('scenes/slide-1.json')).toMatchObject({ fps: 1, duration: 1, size: [1080, 1350] });
    const listed = (await w.listScenes()).find((s: { id: string }) => s.id === 'slide-1') as { frameCount?: number; errors: string[] };
    expect(listed).toMatchObject({ frameCount: 1, errors: [] });
    await expect(w.createScene({ id: 'slide-2', still: true, duration: 3 })).rejects.toThrow(/leave out fps and duration/);
    await expect(w.createScene({ id: 'slide-2' })).rejects.toThrow(/duration/);
    rmSync(path('scenes/slide-1.json'));
  });

  it('exports a PNG at the exact size, with the pixels render_frame writes', async () => {
    const w = await studio.server.workspace();
    const out = await w.export('card', 'png');
    expect(out).toMatchObject({ file: 'out/card/card.png', format: 'png', frame: 0, width: 1080, height: 1350 });
    const png = await pixels(path(out.file));
    expect([png.width, png.height]).toEqual([1080, 1350]);
    const frame = await w.renderFrame('card', 0, 4000);
    expect((await pixels(path(frame.file))).hash).toBe(png.hash);
    // The same pixels on a second run.
    await w.export('card', 'png');
    expect((await pixels(path(out.file))).hash).toBe(png.hash);
  });

  it('exports a JPG whose quality changes its size, flat and close to the PNG', async () => {
    const w = await studio.server.workspace();
    const png = await pixels(path((await w.export('card', 'png')).file));
    const high = await w.export('card', 'jpg', { quality: 95 });
    expect(high).toMatchObject({ file: 'out/card/card.jpg', format: 'jpg', width: 1080, height: 1350 });
    const highBytes = statSync(path(high.file)).size;
    const jpg = await pixels(path(high.file));
    expect([jpg.width, jpg.height]).toEqual([1080, 1350]);
    let off = 0;
    for (let i = 0; i < png.data.length; i += 4 * 97) off = Math.max(off, Math.abs(png.data[i] - jpg.data[i]), Math.abs(png.data[i + 1] - jpg.data[i + 1]), Math.abs(png.data[i + 2] - jpg.data[i + 2]));
    expect(off).toBeLessThan(48);
    const low = await w.export('card', 'jpg', { quality: 20 });
    expect(low.bytes).toBe(statSync(path(low.file)).size);
    expect(low.bytes).toBeLessThan(highBytes * 0.7);
    // 90 when left out, which sits between them.
    const plain = (await w.export('card', 'jpg')).bytes!;
    expect(plain).toBeLessThan(highBytes);
    expect(plain).toBeGreaterThan(low.bytes!);
  });

  it('exports a chosen frame of a longer scene, named with its number', async () => {
    const w = await studio.server.workspace();
    const out = await w.export('moving', 'png', { frame: 7 });
    expect(out).toMatchObject({ file: 'out/moving/moving-00007.png', frame: 7, width: 1080, height: 1350 });
    expect((await w.export('moving', 'jpg', { frame: '00:01:02', quality: 80 })).file).toBe('out/moving/moving-00014.jpg');
    expect((await w.export('moving', 'png')).file).toBe('out/moving/moving-00000.png');
  });

  it('refuses options that belong to another target', async () => {
    const w = await studio.server.workspace();
    await expect(w.export('card', 'png', { from: 0, to: 1 })).rejects.toThrow(/one frame/);
    await expect(w.export('card', 'png', { quality: 80 })).rejects.toThrow(/quality applies to jpg/);
    await expect(w.export('card', 'jpg', { quality: 0 })).rejects.toThrow(/1 to 100/);
    await expect(w.export('card', 'png', { frame: 1 })).rejects.toThrow();
    await expect(w.export('moving', 'mp4', { frame: 3 })).rejects.toThrow(/frame and quality are for png and jpg/);
  });

  it('exports several stills in one call, and says which failed', async () => {
    const w = await studio.server.workspace();
    write('scenes/card-2.json', { ...card, id: 'card-2', size: [1080, 1080] });
    studio.server.touch();
    const all = await w.exportStills();
    expect(all.exported.map((e) => e.scene).sort()).toEqual(['card', 'card-2']);
    expect(all.failed).toEqual([]);
    expect(all.exported.find((e) => e.scene === 'card-2')).toMatchObject({ file: 'out/card-2/card-2.png', width: 1080, height: 1080 });
    const named = await w.exportStills({ sceneIds: ['card-2', 'nope', 'card'], format: 'jpg', quality: 70 });
    expect(named.exported.map((e) => e.file)).toEqual(['out/card-2/card-2.jpg', 'out/card/card.jpg']);
    expect(named.failed).toHaveLength(1);
    expect(named.failed[0].scene).toBe('nope');
    rmSync(path('scenes/card-2.json'));
    studio.server.touch();
  });

  it('checks a still without judging it as a video', async () => {
    const w = await studio.server.workspace();
    const report = await w.check('card');
    expect(report.ok).toBe(true);
    const by = new Map(report.checks.map((c) => [c.id, c]));
    for (const id of ['duration', 'freeze', 'opening', 'loop-seam', 'flashing', 'sparse', 'reading-time']) {
      expect(by.get(id), id).toMatchObject({ status: 'pass', message: 'Skipped: a still has one frame.' });
    }
    expect(by.get('format')).toMatchObject({ status: 'pass' });
    expect(by.get('black')).toMatchObject({ status: 'pass' });
    expect(by.get('text-contrast')?.message).toMatch(/at least/);
    expect(report.checks.every((c) => c.status === 'pass'), JSON.stringify(report.checks.filter((c) => c.status !== 'pass'))).toBe(true);
    // The same picture as two seconds of video is told it never moves.
    const video = await w.check('moving');
    expect(video.checks.find((c) => c.id === 'opening')?.status).toBe('warn');
  });

  it('tells an agent the scene is a still', async () => {
    const w = await studio.server.workspace();
    expect(await w.sceneInfo('card')).toMatchObject({ still: true });
    expect(await w.sceneInfo('moving')).toMatchObject({ still: false });
  });
});

describe('the CLI on a still', () => {
  const cli = (...args: string[]) => run(process.execPath, [join(ROOT, 'tools/render/cli.ts'), ...args, '--folder', folder], { cwd: folder });

  it('exports png and jpg, and every still at once', async () => {
    const png = await cli('export', '--scene', 'card', '--target', 'png');
    expect(png.stdout.trim()).toBe('out/card/card.png');
    expect(png.stderr).toMatch(/1080x1350 png/);
    const direct = await pixels(path('out/card/card.png'));
    expect([direct.width, direct.height]).toEqual([1080, 1350]);

    const jpg = await cli('frame', '--scene', 'moving', '--frame', '5', '--format', 'jpg', '--quality', '60');
    expect(jpg.stdout.trim()).toBe('out/moving/frame-00005.jpg');
    expect((await pixels(path('out/moving/frame-00005.jpg'))).width).toBe(1080);

    rmSync(path('out/card'), { recursive: true, force: true });
    const all = await cli('export', '--stills', '--target', 'jpg', '--quality', '80');
    expect(all.stdout.trim().split('\n')).toEqual(['out/card/card.jpg']);
    expect(existsSync(path('out/card/card.jpg'))).toBe(true);
  });

  it('refuses flags that make no sense for an image', async () => {
    await expect(cli('export', '--scene', 'card', '--target', 'png', '--quality', '80')).rejects.toThrow(/--quality applies to jpg/);
    await expect(cli('export', '--scene', 'card', '--target', 'jpg', '--from', '0')).rejects.toThrow(/exports one frame/);
    await expect(cli('export', '--scene', 'card', '--target', 'mp4', '--frame', '0')).rejects.toThrow(/--frame is for an image/);
  });
});

describe('the viewer on a still', () => {
  it('shows no transport, timeline or range, and says it is a still', async () => {
    await open('card', 1);
    expect(await page.locator('.dock .transport').count()).toBe(0);
    expect(await page.locator('.dock .ruler').count()).toBe(0);
    expect(await page.locator('.dock .token-when').count()).toBe(0);
    expect(await page.locator('.dock .still-badge').textContent()).toBe('Still');
    expect((await page.locator('.scene-meta').textContent())?.replace(/\s+/g, ' ').trim()).toBe('1080×1350 still');
    expect((await page.locator('.dock').boundingBox())!.height).toBeLessThan(60);
    // The keys that move through time do nothing.
    for (const key of ['Space', 'ArrowRight', 'End', 'i', 'o', 'x']) await page.keyboard.press(key);
    expect(await page.evaluate(() => (window as unknown as StudioPage).studio.frame)).toBe(0);
    expect(new URL(page.url()).searchParams.get('from')).toBeNull();
  });

  it('keeps them for a scene with more frames', async () => {
    await open('moving', 24);
    expect(await page.locator('.dock .transport').count()).toBe(1);
    expect(await page.locator('.dock .ruler').count()).toBe(1);
    expect(await page.locator('.dock .still-badge').count()).toBe(0);
  });

  it('selects on a click, and sends a request whose range is the one frame', async () => {
    await open('card', 1);
    const at = await onCanvas(300, 400);
    await page.mouse.click(at.x, at.y);
    await soon(selection).toMatchObject({ layerId: 'dot', from: 0, to: 1 });
    await panel().getByRole('textbox', { name: 'Prompt' }).fill('make the dot blue');
    await panel().getByRole('button', { name: 'Send to agent' }).click();
    await soon(async () => (await studio.server.queue.list()).length).toBe(1);
    const [sent] = await studio.server.queue.list();
    expect(sent.turns[0].ask).toMatchObject({ prompt: 'make the dot blue', frame: 0, selection: { sceneId: 'card', layerId: 'dot', from: 0, to: 1 } });
    const w = await studio.server.workspace();
    expect(await w.describeRequest(sent)).toMatch(/This scene is a still/);
  });

  it('drags a layer and writes the plain param', async () => {
    await open('card', 1);
    const from = await onCanvas(300, 400);
    const to = await onCanvas(500, 460);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await soon(() => layerIn('scenes/card.json', 'dot').params.x).not.toBe(300);
    const moved = layerIn('scenes/card.json', 'dot');
    expect(Math.abs(moved.params.x - 500)).toBeLessThan(4);
    expect(Math.abs(moved.params.y - 460)).toBeLessThan(4);
    expect(moved.tracks).toBeUndefined();
    expect(moved.overrides).toBeUndefined();
  });

  it('drags a layer that had a track, which becomes the param and never a key', async () => {
    write('scenes/card.json', { ...card, layers: [{ ...dot, tracks: [{ param: 'x', keys: [{ t: 0, v: 300 }] }] }, card.layers[1]] });
    await open('card', 1);
    const from = await onCanvas(300, 400);
    const to = await onCanvas(520, 400);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await soon(() => layerIn('scenes/card.json', 'dot').tracks).toBeUndefined();
    expect(Math.abs(layerIn('scenes/card.json', 'dot').params.x - 520)).toBeLessThan(4);
    // Command-Z brings the track back.
    await page.keyboard.press('ControlOrMeta+z');
    await soon(() => layerIn('scenes/card.json', 'dot').tracks).toEqual([{ param: 'x', keys: [{ t: 0, v: 300 }] }]);
  });

  it('exports PNG and JPG from the Export panel, and offers no video for a still', async () => {
    await open('card', 1);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportPanel = page.getByRole('region', { name: 'Export' });
    expect(await exportPanel.getByRole('radio').evaluateAll((radios) => radios.map((r) => (r as HTMLInputElement).value))).toEqual(['png', 'jpg', 'html']);
    expect(await exportPanel.getByRole('radio', { name: 'PNG' }).isChecked()).toBe(true);
    rmSync(path('out/card'), { recursive: true, force: true });
    await exportPanel.getByRole('button', { name: 'Export', exact: true }).click();
    await soon(() => existsSync(path('out/card/card.png'))).toBe(true);
    await soon(async () => (await exportPanel.locator('.export-file').textContent()) ?? '').toBe('card.png');
    expect((await pixels(path('out/card/card.png'))).width).toBe(1080);

    await exportPanel.getByRole('radio', { name: 'JPG' }).check();
    await exportPanel.getByRole('slider', { name: 'JPG quality' }).fill('40');
    await exportPanel.getByRole('button', { name: 'Export', exact: true }).click();
    await soon(() => existsSync(path('out/card/card.jpg'))).toBe(true);
    const low = statSync(path('out/card/card.jpg')).size;
    const w = await studio.server.workspace();
    await w.export('card', 'jpg', { quality: 95 });
    expect(low).toBeLessThan(statSync(path('out/card/card.jpg')).size);
  });

  it('offers PNG and JPG of the frame on screen beside the video formats', async () => {
    await open('moving', 24);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportPanel = page.getByRole('region', { name: 'Export' });
    expect(await exportPanel.getByRole('radio').evaluateAll((radios) => radios.map((r) => (r as HTMLInputElement).value))).toEqual(['mp4', 'gif', 'html', 'png', 'jpg']);
    expect(await exportPanel.getByRole('radio', { name: 'MP4' }).isChecked()).toBe(true);
    await exportPanel.getByRole('radio', { name: 'PNG' }).check();
    await exportPanel.getByRole('button', { name: 'Export', exact: true }).click();
    await soon(() => existsSync(path('out/moving/moving-00002.png'))).toBe(true);
  });

  it('makes a still from New scene, at a social size', async () => {
    await open('card', 1);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New scene' }).click();
    const dialog = page.getByRole('dialog', { name: 'New scene' });
    await dialog.getByLabel('Name').fill('Launch 1');
    // An animation by default, with its length; a still has neither length nor frame rate.
    expect(await dialog.getByText('Length').count()).toBe(1);
    await dialog.getByRole('radio', { name: 'Still' }).check();
    expect(await dialog.getByText('Length').count()).toBe(0);
    expect(await dialog.locator('input[name=new-still-format]').evaluateAll((radios) => radios.map((r) => (r as HTMLInputElement).value))).toEqual(['portrait', 'square', 'story', 'landscape', 'custom']);
    await dialog.locator('input[name=new-still-format][value=landscape]').check();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await soon(() => existsSync(path('scenes/launch-1.json'))).toBe(true);
    expect(read('scenes/launch-1.json')).toMatchObject({ id: 'launch-1', fps: 1, duration: 1, size: [1200, 628] });
    await page.waitForFunction(() => (window as unknown as StudioPage).studio.frameCount === 1 && new URL(location.href).searchParams.get('scene') === 'launch-1');
    await soon(() => page.locator('.dock .still-badge').count()).toBe(1);
    rmSync(path('scenes/launch-1.json'));
  });
});
