/**
 * Carousels and stills in use (ADR 0022), on a temporary studio folder: stills
 * grouped in project.json, exported in order to one folder, shown as a strip
 * under the still and as a row in the Library, reordered, added to and taken
 * from by hand; and a still held as a clip in a video at another fps.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { renderClient, startStudio, type TestStudio } from './studio-server';

let folder: string;
let studio: TestStudio;
let browser: Browser;
let page: Page;

const soon = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
const path = (file: string) => join(folder, file);
const read = (file: string) => JSON.parse(readFileSync(path(file), 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(path(file), JSON.stringify(value, null, 2));
const carousels = () => (existsSync(path('project.json')) ? ((read('project.json').carousels ?? []) as { id: string; slides: string[] }[]) : []);

const still = (id: string, fill: string) => ({
  id,
  fps: 1,
  duration: 1,
  size: [1080, 1350],
  seed: 1,
  background: { rig: 'paper', params: { tone: '#f4efe6' } },
  layers: [{ id: 'dot', rig: 'circle', params: { x: 540, y: 600, radius: 200, fill } }],
});
const STILLS = { 'post-1': '#d04040', 'post-2': '#40a050', 'post-3': '#4050d0', loose: '#808080' };

async function open(scene: string): Promise<void> {
  await page.goto(studio.paired(`?scene=${encodeURIComponent(scene)}`));
  await page.waitForFunction((id) => (window as unknown as { studio?: { frameCount: number; scene: { id: string } | null } }).studio?.scene?.id === id, scene);
}
const sceneNow = () => page.evaluate(() => (window as unknown as { studio: { scene: { id: string } | null } }).studio.scene?.id);
const strip = () => page.locator('.still-strip');
const slides = () => strip().locator('.strip-slide');
const slideNames = () => slides().evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));

beforeAll(async () => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-carousels-')));
  for (const dir of ['scenes', 'compositions']) mkdirSync(path(dir), { recursive: true });
  for (const [id, fill] of Object.entries(STILLS)) write(`scenes/${id}.json`, still(id, fill));
  write('scenes/moving.json', { ...still('moving', '#000000'), fps: 12, duration: 2 });
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

beforeEach(async () => {
  write('project.json', { carousels: [{ id: 'post', slides: ['post-1', 'post-2', 'post-3'] }] });
  studio.server.touch();
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
});

describe('carousels in the tools', () => {
  it('group stills, in one carousel each, and refuse a scene that moves', async () => {
    const w = await studio.server.workspace();
    expect(await w.carousels()).toEqual([{ id: 'post', slides: ['post-1', 'post-2', 'post-3'] }]);
    await expect(w.editCarousels({ op: 'add', carousel: 'post', scene: 'moving' })).rejects.toThrow(/isn't a still: it has 24 frames/);
    await expect(w.editCarousels({ op: 'add', carousel: 'post', scene: 'nope' })).rejects.toThrow(/no scene "nope"/);
    await expect(w.editCarousels({ op: 'create', id: 'loose', slides: ['post-1'] })).rejects.toThrow(/is a scene's name/);
    expect((await w.editCarousels({ op: 'create', id: 'second', slides: ['loose', 'post-3'] })).carousels).toEqual([
      { id: 'post', slides: ['post-1', 'post-2'] },
      { id: 'second', slides: ['loose', 'post-3'] },
    ]);
    expect(carousels()).toHaveLength(2);
    expect((await w.editCarousels({ op: 'delete', carousel: 'second' })).carousels).toEqual([{ id: 'post', slides: ['post-1', 'post-2'] }]);
    // The last carousel gone leaves no field behind.
    await w.editCarousels({ op: 'delete', carousel: 'post' });
    expect(read('project.json').carousels).toBeUndefined();
  });

  it('export a carousel to one folder, numbered as it is swiped', async () => {
    const w = await studio.server.workspace();
    await w.editCarousels({ op: 'move', carousel: 'post', scene: 'post-3', to: 0 });
    const out = await w.exportStills({ carousel: 'post', format: 'jpg', quality: 80 });
    expect(out.folder).toBe('out/post');
    expect(out.exported.map((e) => e.file)).toEqual(['out/post/01-post-3.jpg', 'out/post/02-post-1.jpg', 'out/post/03-post-2.jpg']);
    expect(out.exported.every((e) => e.width === 1080 && e.height === 1350)).toBe(true);
    expect(readdirSync(path('out/post')).sort()).toEqual(['01-post-3.jpg', '02-post-1.jpg', '03-post-2.jpg']);
    await expect(w.exportStills({ carousel: 'nope' })).rejects.toThrow(/no carousel "nope"/);
    await expect(w.exportStills({ carousel: 'post', sceneIds: ['loose'] })).rejects.toThrow(/not both/);
  });

  it('add a slide the size of the last one', async () => {
    const w = await studio.server.workspace();
    const made = await w.addCarouselSlide('post');
    expect(made.id).toBe('post-4');
    expect(read('scenes/post-4.json')).toMatchObject({ fps: 1, duration: 1, size: [1080, 1350] });
    expect(made.carousels[0].slides).toEqual(['post-1', 'post-2', 'post-3', 'post-4']);
    rmSync(path('scenes/post-4.json'));
    studio.server.touch();
  });
});

describe('a carousel in the viewer', () => {
  it('shows its slides under the still, opens one on a click, and steps with the arrows', async () => {
    await open('post-1');
    await soon(slideNames).toEqual(['Slide 1 of 3, post-1', 'Slide 2 of 3, post-2', 'Slide 3 of 3, post-3']);
    expect(await strip().locator('.strip-name').textContent()).toBe('post');
    expect(await slides().nth(0).getAttribute('aria-current')).toBe('true');
    await slides().nth(2).click();
    await soon(sceneNow).toBe('post-3');
    expect(await slides().nth(2).getAttribute('aria-current')).toBe('true');
    await page.keyboard.press('ArrowLeft');
    await soon(sceneNow).toBe('post-2');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await soon(sceneNow).toBe('post-3');
    expect(await strip().locator('.strip-count').textContent()).toBe('3 of 3');
  });

  it('reorders by dragging a slide, into project.json', async () => {
    await open('post-1');
    await soon(() => slides().count()).toBe(3);
    await slides().nth(2).dragTo(slides().nth(0));
    await soon(() => carousels()[0]?.slides).toEqual(['post-3', 'post-1', 'post-2']);
    await soon(slideNames).toEqual(['Slide 1 of 3, post-3', 'Slide 2 of 3, post-1', 'Slide 3 of 3, post-2']);
  });

  it('adds a slide, takes one out, and starts a carousel from a still on its own', async () => {
    await open('post-2');
    await strip().getByRole('button', { name: 'Add a slide' }).click();
    await soon(sceneNow).toBe('post-4');
    await soon(() => carousels()[0]?.slides).toEqual(['post-1', 'post-2', 'post-3', 'post-4']);
    await soon(() => slides().count()).toBe(4);
    await strip().getByRole('button', { name: 'Remove slide' }).click();
    await soon(() => carousels()[0]?.slides).toEqual(['post-1', 'post-2', 'post-3']);
    // Out of the carousel, the still is on its own, and can join one or start one.
    await soon(() => strip().getByText('This still is on its own.').count()).toBe(1);
    expect(existsSync(path('scenes/post-4.json'))).toBe(true);
    await strip().getByRole('combobox', { name: 'Add to a carousel' }).selectOption('post');
    await soon(() => carousels()[0]?.slides).toEqual(['post-1', 'post-2', 'post-3', 'post-4']);
    rmSync(path('scenes/post-4.json'));
    studio.server.touch();

    await open('loose');
    await strip().getByRole('button', { name: 'Start a carousel' }).click();
    await soon(() => carousels().map((c) => c.id)).toEqual(['post', 'loose-set']);
    await soon(slideNames).toEqual(['Slide 1 of 1, loose']);
  });

  it('exports the carousel from the Export panel, in order, and every still', async () => {
    await open('post-2');
    rmSync(path('out'), { recursive: true, force: true });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Export' });
    await panel.getByRole('radio', { name: /Carousel post, 3 slides/ }).check();
    await panel.getByRole('button', { name: 'Export', exact: true }).click();
    await soon(() => (existsSync(path('out/post')) ? readdirSync(path('out/post')).sort() : [])).toEqual(['01-post-1.png', '02-post-2.png', '03-post-3.png']);
    await soon(async () => (await panel.locator('.panel-note').last().textContent()) ?? '').toMatch(/3 stills, numbered in order/);

    await panel.getByRole('radio', { name: 'All 4 stills' }).check();
    await panel.getByRole('button', { name: 'Export', exact: true }).click();
    await soon(() => ['post-1', 'post-2', 'post-3', 'loose'].every((id) => existsSync(path(`out/${id}/${id}.png`)))).toBe(true);
  });

  it('lays the carousel out as a row of slides in the Library, apart from stills on their own and scenes that move', async () => {
    await open('post-1');
    const openLibrary = () => page.getByRole('list', { name: 'Projects' }).locator('.project-row').first().click();
    await openLibrary();
    const stills = page.getByRole('region', { name: 'Stills' });
    await stills.waitFor();
    expect(await stills.locator('.lib-carousel[data-carousel="post"] .lib-slide').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')))).toEqual(['post-1', 'post-2', 'post-3']);
    expect(await stills.locator('.lib-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')))).toEqual(['loose']);
    expect(await page.getByRole('region', { name: 'Scenes' }).locator('.lib-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')))).toEqual(['moving']);
    await stills.locator('.lib-slide[data-key="post-2"]').click();
    await soon(sceneNow).toBe('post-2');

    await openLibrary();
    rmSync(path('out'), { recursive: true, force: true });
    await page.getByRole('region', { name: 'Stills' }).locator('.lib-carousel[data-carousel="post"]').getByRole('button', { name: 'Export' }).click();
    await soon(() => (existsSync(path('out/post')) ? readdirSync(path('out/post')).length : 0)).toBe(3);
  });
});

describe('a still held in a video', () => {
  it('shows for as long as its clip says, at the video\'s fps, with the pixels it has alone', async () => {
    const w = await studio.server.workspace();
    await w.createComposition({ id: 'reel', fps: 30, size: [1080, 1350], duration: 6 });
    await expect(w.updateScene('reel', { tracks: [{ id: 'V1', clips: [{ id: 'card', scene: 'post-1', start: 1 }] }] })).rejects.toThrow(/is a still, which has no length of its own; give out/);
    await w.updateScene('reel', { tracks: [{ id: 'V1', clips: [{ id: 'card', scene: 'post-1', start: 1, out: 4 }] }] });
    const alone = await (await renderClient(studio, 'post-1')).call('pixelHash', 0);
    const reel = await renderClient(studio, 'reel');
    expect(reel.scene.frameCount).toBe(180);
    // Before it starts the video is its background; then the still, on every frame, to the frame it ends on.
    expect(await reel.call('pixelHash', 29)).not.toBe(alone);
    for (const frame of [30, 31, 90, 149]) expect(await reel.call('pixelHash', frame), `frame ${frame}`).toBe(alone);
    expect(await reel.call('pixelHash', 150)).not.toBe(alone);
  });

  it('lands on the timeline three seconds long, and its edge drags out past its own second', async () => {
    const w = await studio.server.workspace();
    await w.updateScene('reel', { tracks: [{ id: 'V1', clips: [] }] });
    const made = await w.editTimeline('reel', { op: 'add-clip', source: { scene: 'post-2' }, at: 0, length: 0, track: 'V1' });
    const clip = () => read('compositions/reel.json').tracks[0].clips[0];
    expect(clip()).toMatchObject({ id: made.made, scene: 'post-2', out: 3 });
    // The route a dragged edge saves through.
    const moved = await fetch(`${studio.base}__studio/compositions/reel/clip`, { method: 'POST', headers: { ...studio.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ clip: made.made, start: 0, in: 0, out: 5.5 }) });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(clip().out).toBe(5.5);
    const reel = await renderClient(studio, 'reel');
    expect(await reel.call('pixelHash', 164)).toBe(await (await renderClient(studio, 'post-2')).call('pixelHash', 0));
  });
});
