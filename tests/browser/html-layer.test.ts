/**
 * HTML layers (ADR 0021) on a page written for the test, so it needs no
 * network: a still made from a page, drawn by the render worker and the
 * viewer, the same at device scale 1 and 2, with elements that select, outline
 * and drag, a page edit that shows, and the hosts that refuse it. The owner's
 * real slides are in html-slides.test.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { electronPage } from './electron-page';
import { startStudio, type TestStudio } from './studio-server';

let folder: string;
let source: string;
let studio: TestStudio;
let browser: Browser;
let page: Page;

const SIZE = [640, 800] as const;
const soon = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 20_000 });
const path = (file: string) => join(folder, file);
const read = (file: string) => JSON.parse(readFileSync(path(file), 'utf8'));
const layer = () => read('scenes/card.json').layers[0] as { id: string; html: string; offsets?: Record<string, [number, number]> };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../kit/card.css"></head><body>
<div class="post"><h1 id="title">Hello stills</h1><p class="lede">One frame, drawn by the browser.</p>
<div class="btn">Get a demo</div><div class="row"><span class="chip">One</span><span class="chip">Two</span></div><img class="mark" src="../kit/mark.svg">
<script>document.body.style.background = 'rgb(255, 0, 0)'; document.querySelector('.btn').remove();</script></div></body></html>`;
const CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 640px; height: 800px; overflow: hidden; }
body { background: rgb(20, 30, 40); font-family: Helvetica, Arial, sans-serif; color: #fff; }
.post { position: absolute; inset: 20px; border-radius: 40px; background: linear-gradient(180deg, rgb(40, 60, 90), rgb(20, 30, 40)); overflow: hidden; }
h1 { position: absolute; left: 40px; top: 60px; font-size: 64px; }
.lede { position: absolute; left: 40px; top: 160px; font-size: 26px; }
.btn { position: absolute; left: 40px; top: 400px; width: 240px; height: 80px; border-radius: 20px; background: rgb(240, 120, 20); display: flex; align-items: center; justify-content: center; font-size: 28px; animation: pulse 1s infinite alternate; }
@keyframes pulse { from { opacity: 1; } to { opacity: 0.2; } }
.row { position: absolute; left: 40px; top: 560px; display: flex; gap: 12px; }
.chip { padding: 8px 18px; border-radius: 99px; background: rgb(60, 160, 90); font-size: 20px; }
.mark { position: absolute; right: 40px; bottom: 40px; width: 80px; height: 80px; }`;
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="rgb(250, 220, 60)"/></svg>';

async function pixels(file: string): Promise<{ width: number; height: number; hash: string; at(x: number, y: number): number[] }> {
  const image = await loadImage(readFileSync(file));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, hash: createHash('sha256').update(data).digest('hex'), at: (x, y) => [...data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)] };
}

interface StudioPage {
  studio: { frameCount: number; canvas: HTMLCanvasElement; selection: { layerId?: string; partId?: string } | null; errors: string[] };
}

async function open(target: Page = page): Promise<void> {
  await target.goto(studio.paired('?scene=card'));
  await target.waitForFunction(() => (window as unknown as StudioPage).studio?.frameCount === 1);
}

/** The viewer's canvas at a scene pixel, once the page has drawn there. */
const canvasPixel = (x: number, y: number, target: Page = page) =>
  target.evaluate(
    ([px, py, width]) => {
      // The viewer's canvas is as big as it shows, so a scene pixel is scaled to it.
      const canvas = (window as unknown as StudioPage).studio.canvas;
      const k = canvas.width / width;
      return [...canvas.getContext('2d')!.getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data.slice(0, 3)];
    },
    [x, y, SIZE[0]],
  );
/** The page as the viewer's own code draws it for render(), before the canvas scales it: its size and a hash of its pixels. */
const pageHash = (target: Page) =>
  // As text, so the test runner leaves the import to the page.
  target.evaluate(`(async () => {
    const { HtmlPages } = await import('/src/export/html-pages.ts');
    const pages = new HtmlPages((file) => '/__studio/' + file);
    const picture = await pages.draw({ file: 'html/deck/posts/1.html', width: 640, height: 800, offsets: { 'div.btn': [10, 20] } });
    const data = picture.image.getContext('2d').getImageData(0, 0, picture.width, picture.height).data;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    pages.dispose();
    return picture.width + 'x' + picture.height + ' ' + [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  })()`) as Promise<string>;
const drawn = (target: Page = page) => soon(() => canvasPixel(100, 440, target)).toEqual([240, 120, 20]);

async function onCanvas(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.stage-canvas').boundingBox())!;
  return { x: box.x + (x / SIZE[0]) * box.width, y: box.y + (y / SIZE[1]) * box.height };
}
const selection = () => page.evaluate(() => (window as unknown as StudioPage).studio.selection);
async function clickScene(x: number, y: number): Promise<void> {
  const at = await onCanvas(x, y);
  await page.mouse.click(at.x, at.y);
}

beforeAll(async () => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-html-')));
  source = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-html-src-')));
  mkdirSync(path('scenes'), { recursive: true });
  for (const dir of ['kit', 'posts']) mkdirSync(join(source, 'deck', dir), { recursive: true });
  writeFileSync(join(source, 'deck/posts/1.html'), PAGE);
  writeFileSync(join(source, 'deck/posts/2.html'), PAGE.replace('Hello stills', 'Second slide'));
  writeFileSync(join(source, 'deck/kit/card.css'), CSS);
  writeFileSync(join(source, 'deck/kit/mark.svg'), MARK);
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
  const w = await studio.server.workspace();
  const made = await w.createHtmlStills({ files: [join(source, 'deck/posts')], name: 'deck', size: [640, 800], ids: ['card', 'card-two'] });
  expect(made).toMatchObject({ html: 'html/deck', copied: 4, localized: [], failed: [] });
  expect(made.scenes).toEqual([
    { id: 'card', file: 'scenes/card.json', html: 'html/deck/posts/1.html' },
    { id: 'card-two', file: 'scenes/card-two.json', html: 'html/deck/posts/2.html' },
  ]);
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1 });
});

describe('an html layer in the tools', () => {
  it('is a still with one layer, and the page keeps its paths', () => {
    expect(read('scenes/card.json')).toMatchObject({ id: 'card', fps: 1, duration: 1, size: [640, 800], layers: [{ id: 'page', html: 'html/deck/posts/1.html' }] });
    expect(read('scenes/card.json').background).toBeUndefined();
    expect(readFileSync(path('html/deck/posts/1.html'), 'utf8')).toBe(PAGE);
    expect(readFileSync(path('html/deck/kit/card.css'), 'utf8')).toBe(CSS);
  });

  it('exports at the exact size, with the stylesheet and image applied, scripts and animations off, the same on every run', async () => {
    const w = await studio.server.workspace();
    const out = await w.export('card', 'png');
    expect(out).toMatchObject({ file: 'out/card/card.png', width: 640, height: 800 });
    const png = await pixels(path(out.file));
    expect([png.width, png.height]).toEqual([640, 800]);
    // The body, outside the rounded post: the script would have turned it red.
    expect(png.at(4, 4)).toEqual([20, 30, 40]);
    // The button the script would have removed, at full opacity though its animation fades it.
    expect(png.at(100, 440)).toEqual([240, 120, 20]);
    // The SVG beside the stylesheet.
    expect(png.at(560, 720)).toEqual([250, 220, 60]);
    await w.export('card', 'png');
    expect((await pixels(path(out.file))).hash).toBe(png.hash);
    expect((await w.export('card', 'jpg', { quality: 80 })).width).toBe(640);
    const all = await w.exportStills();
    expect(all.exported.map((e) => e.scene).sort()).toEqual(['card', 'card-two']);
    expect((await pixels(path('out/card-two/card-two.png'))).hash).not.toBe(png.hash);
  });

  it('names the element under a pixel in hit_test, by id or by a selector that finds it alone', async () => {
    const w = await studio.server.workspace();
    expect(await w.hitTest('card', 0, 100, 440)).toMatchObject({ layerId: 'page', partId: 'div.btn' });
    expect(await w.hitTest('card', 0, 100, 110)).toMatchObject({ layerId: 'page', partId: '#title' });
    // Two chips look alike, so the second says which it is.
    expect(await w.hitTest('card', 0, 175, 600)).toMatchObject({ partId: 'span.chip:nth-child(2)' });
    // The bare page has no element to name.
    expect((await w.hitTest('card', 0, 4, 4)).partId).toBeUndefined();
  });

  it('refuses what an html layer can not be', async () => {
    const w = await studio.server.workspace();
    const page1 = { id: 'page', html: 'html/deck/posts/1.html' };
    await expect(w.updateScene('card', { duration: 2 })).rejects.toThrow(/belongs on a still/);
    await expect(w.updateScene('card', { layers: [{ ...page1, html: 'html/deck/posts/nope.html' }] })).rejects.toThrow(/isn't in the studio folder/);
    await expect(w.updateScene('card', { layers: [{ ...page1, html: '../secrets.html' }] })).rejects.toThrow(/must be an \.html file in the studio folder's html\//);
    await expect(w.updateScene('card', { layers: [{ ...page1, rig: 'circle' }] })).rejects.toThrow(/names only its page/);
    await expect(w.updateScene('card', { layers: [{ ...page1, tracks: [{ param: 'x', keys: [{ t: 0, v: 1 }] }] }] })).rejects.toThrow(/takes no tracks/);
    await expect(w.updateScene('card', { layers: [{ ...page1, offsets: { 'div.btn': [1] } }] })).rejects.toThrow(/must be \[x, y\]/);
    await expect(w.updateScene('card', { pixel: { scale: 2 } })).rejects.toThrow(/pixel stage/);
    // The one-file embed has no browser to lay a page out with.
    await expect(w.export('card', 'html')).rejects.toThrow(/can't carry html layers \(ADR 0021\): html\/deck\/posts\/1\.html/);
    expect(read('scenes/card.json').layers).toEqual([page1]);
  });

  it('serves pages under a policy with no scripts and no other origin, and nothing outside html/', async () => {
    const get = (file: string) => fetch(`${studio.base}__studio/${file}`, { headers: studio.auth });
    const res = await get('html/deck/posts/1.html');
    expect(res.status).toBe(200);
    const policy = res.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/script-src 'none'/);
    expect(policy).toMatch(/default-src 'none'/);
    expect(policy).toMatch(/sandbox allow-same-origin/);
    expect((await get('html/deck/kit/card.css')).headers.get('content-type')).toMatch(/text\/css/);
    expect((await get('html/..%2Fscenes/card.json')).status).toBe(404);
    expect((await get('html/deck/posts/missing.html')).status).toBe(404);
  });
});

describe('an html layer in the viewer', () => {
  it('draws the page, and lets it go at once without taking the renderer down', async () => {
    await open();
    await drawn();
    expect(await canvasPixel(4, 4)).toEqual([20, 30, 40]);
    // Drawing and disposing in one turn crashed Chromium 153 until a page left after its next paint.
    expect(await pageHash(page)).toMatch(/^640x800 [0-9a-f]{64}$/);
    expect(await canvasPixel(4, 4)).toEqual([20, 30, 40]);
  });

  it('draws the same bytes in Electron at device scale 1 and 2, which are the bytes the worker exports', async () => {
    const w = await studio.server.workspace();
    await w.updateScene('card', { layers: [{ id: 'page', html: 'html/deck/posts/1.html', offsets: { 'div.btn': [10, 20] } }] });
    try {
      const exported = (await pixels(path((await w.export('card', 'png')).file))).hash;
      for (const scale of [1, 2]) {
        const electron = await electronPage({ scale });
        try {
          await electron.page.goto(studio.paired('?scene=none'));
          expect(await electron.page.evaluate(() => devicePixelRatio)).toBe(scale);
          expect(await pageHash(electron.page), `device scale ${scale}`).toBe(`640x800 ${exported}`);
        } finally {
          await electron.close();
        }
      }
    } finally {
      await w.updateScene('card', { layers: [{ id: 'page', html: 'html/deck/posts/1.html' }] });
    }
  });

  it('selects the element under a click, outlines it, and the same click again takes the whole page', async () => {
    await open();
    await drawn();
    await clickScene(100, 440);
    await soon(selection).toMatchObject({ layerId: 'page', partId: 'div.btn' });
    expect((await page.locator('.dock .token-who').textContent())?.trim()).toBe('page › div.btn');
    // The tag sits over the button, not over the page's corner.
    const tag = (await page.locator('.stage-tag.is-selected').boundingBox())!;
    const button = await onCanvas(60, 420);
    expect(Math.abs(tag.x - button.x)).toBeLessThan(30);
    expect(tag.y).toBeGreaterThan((await onCanvas(0, 300)).y);
    await clickScene(100, 110);
    await soon(selection).toMatchObject({ layerId: 'page', partId: '#title' });
    await clickScene(100, 110);
    await soon(async () => (await selection())?.partId).toBeUndefined();
    expect((await selection())?.layerId).toBe('page');
  });

  it('drags an element, writes its offset on the layer, shows it in the export, and undoes it', async () => {
    await open();
    await drawn();
    const from = await onCanvas(100, 440);
    const to = await onCanvas(300, 640);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await soon(() => layer().offsets?.['div.btn']?.[0] ?? 0).toBeGreaterThan(150);
    const [dx, dy] = layer().offsets!['div.btn'];
    expect(Math.abs(dx - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(dy - 200)).toBeLessThanOrEqual(3);
    expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
    expect(readFileSync(path('html/deck/posts/1.html'), 'utf8')).toBe(PAGE);
    await soon(selection).toMatchObject({ layerId: 'page', partId: 'div.btn' });
    // The viewer shows it where it landed, and so does the worker.
    await soon(() => canvasPixel(100 + dx, 440 + dy)).toEqual([240, 120, 20]);
    expect(await canvasPixel(100, 440)).not.toEqual([240, 120, 20]);
    const w = await studio.server.workspace();
    const png = await pixels(path((await w.export('card', 'png')).file));
    expect(png.at(100 + dx, 440 + dy)).toEqual([240, 120, 20]);
    expect(png.at(100, 440)).not.toEqual([240, 120, 20]);

    await page.keyboard.press('ControlOrMeta+z');
    await soon(() => layer().offsets).toBeUndefined();
    await soon(() => canvasPixel(100, 440)).toEqual([240, 120, 20]);
  });

  it('sends a request that names the element and its page', async () => {
    await open();
    await drawn();
    await clickScene(100, 440);
    await soon(selection).toMatchObject({ partId: 'div.btn' });
    const panel = page.getByRole('complementary', { name: 'Agent' });
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('rounder corners');
    await panel.getByRole('button', { name: 'Send to agent' }).click();
    await soon(async () => (await studio.server.queue.list()).length).toBe(1);
    const [sent] = await studio.server.queue.list();
    expect(sent.turns[0].ask.selection).toMatchObject({ sceneId: 'card', layerId: 'page', partId: 'div.btn', from: 0, to: 1 });
    const told = await (await studio.server.workspace()).describeRequest(sent);
    expect(told).toMatch(/Layer page is an HTML layer that shows html\/deck\/posts\/1\.html/);
    expect(told).toMatch(/div\.btn/);
    expect(told).toMatch(/This scene is a still/);
  });

  it('draws again when the page or its stylesheet changes', async () => {
    await open();
    await drawn();
    writeFileSync(path('html/deck/kit/card.css'), CSS.replace('rgb(240, 120, 20)', 'rgb(30, 200, 220)'));
    await soon(() => canvasPixel(100, 440)).toEqual([30, 200, 220]);
    const w = await studio.server.workspace();
    expect((await pixels(path((await w.export('card', 'png')).file))).at(100, 440)).toEqual([30, 200, 220]);
    writeFileSync(path('html/deck/kit/card.css'), CSS);
    await soon(() => canvasPixel(100, 440)).toEqual([240, 120, 20]);
  });

  it("says why it can't draw the page in a browser without the API", async () => {
    const plain = await launchBrowser({ htmlInCanvas: false });
    try {
      const other = await plain.newPage({ viewport: { width: 1300, height: 1000 } });
      await open(other);
      await expect.poll(() => other.locator('.error-panel').textContent(), { timeout: 20_000 }).toMatch(/This browser can't draw HTML layers/);
    } finally {
      await plain.close();
    }
  });
});
