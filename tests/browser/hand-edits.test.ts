/**
 * Hand edits (ADR 0015) in the viewer, on temporary scenes: keys dragged and
 * deleted on the timeline, layers dragged on the canvas down each of the three
 * write paths, Command-Z over all of it, and the lock while an agent works.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

let folder: string;
let studio: TestStudio;
let browser: Browser;
let page: Page;

interface StudioPage {
  studio: { frameCount: number; seek(frame: number): number; select(id: string | null): void; setRange(from: number, to: number): void; selection: { layerId?: string } | null; scene: unknown };
}

const FPS = 12;
/** The first edit on a server loads its code, which takes a few seconds under load. */
const soon = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
const ball = {
  id: 'ball',
  rig: 'circle',
  params: { x: 320, y: 180, radius: 50, fill: '#d04040' },
  tracks: [
    { param: 'opacity', keys: [{ t: 1, v: 0 }, { t: 1.5, v: 1 }, { t: 3, v: 1 }] },
    { param: 'scale', keys: [{ t: 1.5, v: 1, ease: 'inOutCubic' }, { t: 3, v: 2 }] },
  ],
};
const mover = {
  id: 'mover',
  rig: 'circle',
  params: { y: 280, radius: 30, fill: '#4050d0' },
  tracks: [{ param: 'x', keys: [{ t: 0, v: 100, ease: 'inOutCubic' }, { t: 4, v: 500 }] }],
};
const keysScene = { id: 'keys', fps: FPS, duration: 4, size: [640, 360], seed: 1, background: { rig: 'paper' }, layers: [mover, ball] };

const path = (file: string) => join(folder, file);
const read = (file = 'scenes/keys.json') => JSON.parse(readFileSync(path(file), 'utf8'));
const layerIn = (file: string, id: string) => read(file).layers.find((l: { id: string }) => l.id === id);
const inFile = (id: string) => layerIn('scenes/keys.json', id);
const write = (file: string, value: unknown) => writeFileSync(path(file), JSON.stringify(value, null, 2));

async function open(scene: string, frames: number): Promise<void> {
  await page.goto(studio.paired(`?scene=${encodeURIComponent(scene)}`));
  await page.waitForFunction((n) => (window as unknown as StudioPage).studio?.frameCount === n, frames);
  await page.waitForFunction(() => !!document.querySelector('.ruler')?.getBoundingClientRect().width);
}

const select = (id: string | null) => page.evaluate((layer) => (window as unknown as StudioPage).studio.select(layer), id);
const seek = (frame: number) => page.evaluate((f) => (window as unknown as StudioPage).studio.seek(f), frame);
const frameNow = () => page.evaluate(() => (window as unknown as { studio: { frame: number } }).studio.frame);

/** A diamond's button, on a layer's row or on one of its lanes. */
const rowKey = (layer: string, nth: number) => page.locator(`.tl-row[data-layer="${layer}"] .key-mark`).nth(nth);
const laneKey = (param: string, nth: number) => page.locator(`.key-lane[data-lane="${param}"] .key-mark`).nth(nth);

async function centre(locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const perFrame = async (frames: number) => (await page.locator('.ruler').boundingBox())!.width / frames;

/** A point on the canvas, in scene pixels, as client pixels. */
async function onCanvas(x: number, y: number, size: readonly [number, number] = [640, 360]): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.stage-canvas').boundingBox())!;
  return { x: box.x + (x / size[0]) * box.width, y: box.y + (y / size[1]) * box.height };
}

/** Client pixels per scene pixel. */
const canvasScale = async (width = 640) => (await page.locator('canvas.stage-canvas').boundingBox())!.width / width;

const notice = () => page.locator('.dock-bar').textContent();

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-hand-edits-'));
  for (const dir of ['scenes', 'compositions', 'projects/film']) mkdirSync(path(dir), { recursive: true });
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

beforeEach(async () => {
  write('scenes/keys.json', keysScene);
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
});

describe('editing keys on the timeline', () => {
  it('shows a bar for when the layer is on screen, and diamonds with their params and time', async () => {
    await open('keys', 48);
    const bar = (await page.locator('.tl-row[data-layer="ball"] .row-bar').boundingBox())!;
    const px = await perFrame(48);
    const ruler = (await page.locator('.ruler').boundingBox())!;
    expect(bar.x - ruler.x).toBeCloseTo(px * 13, 0);
    expect(await page.locator('.tl-row[data-layer="mover"] .row-bar.is-quiet').count()).toBe(1);
    expect(await rowKey('ball', 1).getAttribute('title')).toMatch(/^opacity, scale at 0:01\.50\./);
    const mark = (await rowKey('ball', 0).boundingBox())!;
    expect(mark.x + mark.width / 2 - ruler.x).toBeCloseTo(px * 12, 0);
  });

  it('opens a lane per param on the selected row only', async () => {
    await open('keys', 48);
    expect(await page.locator('.key-lane').count()).toBe(0);
    await page.locator('.tl-row[data-layer="ball"] .row-head').click();
    expect(await page.locator('.key-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))).toEqual(['opacity', 'scale']);
    expect((await page.locator('.key-lane').first().boundingBox())!.height).toBeCloseTo(20, 0);
    await page.locator('.tl-row[data-layer="mover"] .row-head').click();
    expect(await page.locator('.key-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))).toEqual(['x']);
  });

  it('drags a row diamond with every param at that time, and undoes it', async () => {
    await open('keys', 48);
    const px = await perFrame(48);
    const at = await centre(rowKey('ball', 1));
    await drag(at, { x: at.x + px * 3, y: at.y });
    await soon(() => inFile('ball').tracks[0].keys[1].t).toBe(1.75);
    expect(inFile('ball').tracks[1].keys[0]).toEqual({ t: 1.75, v: 1, ease: 'inOutCubic' });
    // Selected where it landed.
    expect(await page.locator('.tl-row[data-layer="ball"] .key-mark.is-selected').count()).toBe(1);

    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').tracks[0].keys[1].t).toBe(1.5);
    expect(inFile('ball').tracks[1].keys[0].t).toBe(1.5);
    await page.keyboard.press('Meta+Shift+z');
    await soon(() => inFile('ball').tracks[1].keys[0].t).toBe(1.75);
  });

  it("drags a lane diamond with that param's key alone, stopping short of its neighbour", async () => {
    await open('keys', 48);
    await select('ball');
    const px = await perFrame(48);
    const at = await centre(laneKey('opacity', 1));
    await drag(at, { x: at.x + px * 40, y: at.y });
    await soon(() => inFile('ball').tracks[0].keys[1].t).toBe(2.916667);
    expect(inFile('ball').tracks[1].keys[0].t).toBe(1.5);
  });

  it('snaps to a marker within 6 px', async () => {
    write('scenes/keys.json', { ...keysScene, markers: [{ t: 2, label: 'beat' }] });
    await open('keys', 48);
    await select('ball');
    const px = await perFrame(48);
    const at = await centre(laneKey('scale', 0));
    await drag(at, { x: at.x + px * 6 - 4, y: at.y });
    await soon(() => inFile('ball').tracks[1].keys[0].t).toBe(2);
  });

  it('selects with a click, nudges with the arrows, and leaves the playhead alone until then', async () => {
    await open('keys', 48);
    await select('ball');
    await seek(5);
    await laneKey('scale', 0).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await soon(() => inFile('ball').tracks[1].keys[0].t).toBe(2.5);
    expect(await frameNow()).toBe(5);
    // One edit, however many presses.
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').tracks[1].keys[0].t).toBe(1.5);

    await laneKey('scale', 0).click();
    await page.keyboard.press('Escape');
    expect(await page.locator('.key-mark.is-selected').count()).toBe(0);
    await page.keyboard.press('ArrowRight');
    expect(await frameNow()).toBe(6);
  });

  it('deletes a key with the keyboard and from its menu, and a last key leaves its value as the param', async () => {
    await open('keys', 48);
    await select('ball');
    await laneKey('scale', 1).click();
    await page.keyboard.press('Delete');
    await soon(() => inFile('ball').tracks[1].keys.length).toBe(1);

    await laneKey('scale', 0).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete key' }).click();
    await soon(() => inFile('ball').tracks.length).toBe(1);
    expect(inFile('ball').params.scale).toBe(1);

    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').tracks.length).toBe(2);
    expect(inFile('ball').params.scale).toBeUndefined();
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').tracks[1].keys.length).toBe(2);
    expect(inFile('ball')).toEqual(ball);
  });

  it("shifts a layer's keys and overrides by its bar, and a fade's pair by its end", async () => {
    write('scenes/keys.json', { ...keysScene, layers: [mover, { ...ball, overrides: [{ from: 20, to: 24, params: { fill: '#000000' } }] }] });
    await open('keys', 48);
    const px = await perFrame(48);
    const bar = (await page.locator('.tl-row[data-layer="ball"] .row-bar').first().boundingBox())!;
    const y = bar.y + bar.height / 2;
    const body = bar.x + px * 2;
    await drag({ x: body, y }, { x: body - px * 6, y });
    await soon(() => inFile('ball').tracks[0].keys[0].t).toBe(0.5);
    expect(inFile('ball').tracks[1].keys[1].t).toBe(2.5);
    expect(inFile('ball').overrides[0]).toMatchObject({ from: 14, to: 18 });
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').tracks[0].keys[0].t).toBe(1);

    await page.waitForFunction(() => document.querySelector('.tl-row[data-layer="ball"] .bar-edge.is-start'));
    const edge = await centre(page.locator('.tl-row[data-layer="ball"] .bar-edge.is-start'));
    await drag(edge, { x: edge.x + px * 3, y: edge.y });
    await soon(() => inFile('ball').tracks[0].keys[0].t).toBe(1.25);
    expect(inFile('ball').tracks[0].keys[1].t).toBe(1.75);
    expect(inFile('ball').tracks[0].keys[2].t).toBe(3);
  });

  it('puts a drag back on Escape', async () => {
    await open('keys', 48);
    const px = await perFrame(48);
    const at = await centre(rowKey('ball', 1));
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + px * 5, at.y, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(inFile('ball')).toEqual(ball);
    const back = await centre(rowKey('ball', 1));
    expect(back.x).toBeCloseTo(at.x, 0);
  });

  it("works on an old film's scene, by its qualified id", async () => {
    write('projects/film/project.json', { name: 'Film', fps: FPS, size: [640, 360], main: 'shot' });
    write('projects/film/shot.json', { ...keysScene, id: 'shot' });
    try {
      await open('film/shot', 48);
      const px = await perFrame(48);
      const at = await centre(rowKey('ball', 1));
      await drag(at, { x: at.x - px * 3, y: at.y });
      await soon(() => read('projects/film/shot.json').layers[1].tracks[0].keys[1].t).toBe(1.25);
    } finally {
      rmSync(path('projects/film/project.json'));
      rmSync(path('projects/film/shot.json'));
    }
  });
});

describe('dragging on the canvas', () => {
  it('writes params for an untracked layer, and undoes it', async () => {
    await open('keys', 48);
    await seek(24);
    const scale = await canvasScale();
    const from = await onCanvas(320, 180);
    await drag(from, { x: from.x + 40 * scale, y: from.y - 20 * scale });
    await soon(() => inFile('ball').params.x).toBeCloseTo(360, 0);
    expect(inFile('ball').params.y).toBeCloseTo(160, 0);
    expect(await page.evaluate(() => (window as unknown as StudioPage).studio.selection?.layerId)).toBe('ball');
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').params.x).toBe(320);
    await page.keyboard.press('Meta+Shift+z');
    await soon(() => inFile('ball').params.x).toBeCloseTo(360, 0);
  });

  it('writes a key at the playhead for a tracked axis, with the ease before it', async () => {
    await open('keys', 48);
    await seek(24);
    const scale = await canvasScale();
    const from = await onCanvas(300, 280);
    await drag(from, { x: from.x + 50 * scale, y: from.y });
    await soon(() => inFile('mover').tracks[0].keys.length).toBe(3);
    const key = inFile('mover').tracks[0].keys[1];
    expect(key.t).toBe(2);
    expect(key.v).toBeCloseTo(350, 0);
    expect(key.ease).toBe('inOutCubic');
    expect(inFile('mover').params.y).toBe(280);
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('mover').tracks[0].keys.length).toBe(2);
    expect(inFile('mover')).toEqual(mover);
  });

  it('writes an override on the range, updates it, and refuses an overlap', async () => {
    await open('keys', 48);
    await seek(24);
    await page.evaluate(() => (window as unknown as StudioPage).studio.setRange(20, 30));
    const scale = await canvasScale();
    const from = await onCanvas(320, 180);
    await drag(from, { x: from.x + 40 * scale, y: from.y });
    await soon(() => inFile('ball').overrides?.length).toBe(1);
    expect(inFile('ball').overrides[0]).toMatchObject({ from: 20, to: 30 });
    expect(inFile('ball').overrides[0].params.x).toBeCloseTo(360, 0);
    expect(inFile('ball').params.x).toBe(320);

    const moved = await onCanvas(360, 180);
    await drag(moved, { x: moved.x + 20 * scale, y: moved.y });
    await soon(() => inFile('ball').overrides[0].params.x).toBeCloseTo(380, 0);
    expect(inFile('ball').overrides).toHaveLength(1);

    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').overrides[0].params.x).toBeCloseTo(360, 0);
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball').overrides).toBeUndefined();

    write('scenes/keys.json', { ...keysScene, layers: [mover, { ...ball, overrides: [{ from: 26, to: 34, params: { fill: '#000000' } }] }] });
    await page.waitForFunction(() => document.querySelector('.tl-row[data-layer="ball"] .row-override'));
    const start = await onCanvas(320, 180);
    await drag(start, { x: start.x + 30 * scale, y: start.y });
    await soon(notice).toMatch(/override crossing/);
    expect(inFile('ball').overrides).toHaveLength(1);
    expect(inFile('ball').params.x).toBe(320);
  });

  it('still selects with a click, and cycles', async () => {
    await open('keys', 48);
    await seek(24);
    const at = await onCanvas(320, 180);
    await page.mouse.click(at.x, at.y);
    expect(await page.evaluate(() => (window as unknown as StudioPage).studio.selection?.layerId)).toBe('ball');
    await page.mouse.click(at.x, at.y);
    expect(await page.evaluate(() => (window as unknown as StudioPage).studio.selection?.layerId)).toBe('background');
    await page.waitForTimeout(100);
    expect(inFile('ball')).toEqual(ball);
  });

  it('moves the selected layer from under another, keeping a part, and locks an axis with Shift', async () => {
    await open('keys', 48);
    await seek(24);
    const scale = await canvasScale();
    const from = await onCanvas(320, 180);
    await page.mouse.move(from.x, from.y);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(from.x + 60 * scale, from.y + 10 * scale, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await soon(() => inFile('ball').params.x).toBeCloseTo(380, 0);
    expect(inFile('ball').params.y).toBe(180);
  });

  it('puts a drag back on Escape, and shows the move only on screen until release', async () => {
    await open('keys', 48);
    await seek(24);
    const scale = await canvasScale();
    const from = await onCanvas(320, 180);
    const pixel = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.stage-canvas')!;
        return [...canvas.getContext('2d')!.getImageData(Math.round((430 / 640) * canvas.width), Math.round(canvas.height / 2), 1, 1).data];
      });
    const before = await pixel();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 110 * scale, from.y, { steps: 5 });
    await page.waitForFunction(() => document.querySelector('canvas.stage-canvas')?.classList.contains('is-dragging'));
    await page.waitForTimeout(100);
    expect(await pixel()).not.toEqual(before);
    expect(inFile('ball').params.x).toBe(320);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await pixel()).toEqual(before);
    expect(inFile('ball')).toEqual(ball);
    expect(await page.locator('canvas.stage-canvas').evaluate((c) => c.classList.contains('is-dragging'))).toBe(false);
  });

  it('tells you once when a rig sets its own position', async () => {
    await open('keys', 48);
    await seek(24);
    const from = await onCanvas(40, 40);
    await drag(from, { x: from.x + 50, y: from.y });
    await soon(notice).toMatch(/Position is set by this rig/);
    expect(read().background).toEqual({ rig: 'paper' });
    await page.evaluate(() => (window as unknown as StudioPage).studio.select(null));
    await drag(from, { x: from.x + 50, y: from.y });
    await page.waitForTimeout(50);
    expect(await notice()).not.toMatch(/Position is set by this rig/);
  });

  it('moves a clip in a composition', async () => {
    write('compositions/cut.json', { id: 'cut', fps: FPS, duration: 4, size: [640, 360], tracks: [{ id: 'V1', clips: [{ id: 'one', scene: 'keys', params: { scale: 0.5 } }] }] });
    try {
      await open('cut', 48);
      await seek(24);
      const scale = await canvasScale();
      const from = await onCanvas(320, 180);
      await drag(from, { x: from.x + 40 * scale, y: from.y + 10 * scale });
      const clip = () => read('compositions/cut.json').tracks[0].clips[0];
      await soon(() => clip().params.x).toBeCloseTo(40, 0);
      expect(clip().params.y).toBeCloseTo(10, 0);
      await page.keyboard.press('Meta+z');
      await soon(() => clip().params.x).toBeUndefined();
    } finally {
      rmSync(path('compositions/cut.json'));
    }
  });

  it('brings back an override that a clip move dropped', async () => {
    const overrides = [{ from: 44, to: 48, params: { opacity: 0.5 } }];
    write('compositions/cut.json', { id: 'cut', fps: FPS, duration: 4, size: [640, 360], tracks: [{ id: 'V1', clips: [{ id: 'one', scene: 'keys', overrides }] }] });
    try {
      await open('cut', 48);
      const band = page.getByRole('group', { name: 'Shots' }).getByRole('button');
      const box = (await band.boundingBox())!;
      const px = await perFrame(48);
      await drag({ x: box.x + 100, y: box.y + 8 }, { x: box.x + 100 + px * 12, y: box.y + 8 });
      const clip = () => read('compositions/cut.json').tracks[0].clips[0];
      await soon(() => clip().start).toBe(1);
      expect(clip().overrides).toBeUndefined();
      await page.keyboard.press('Meta+z');
      await soon(() => clip().start).toBeUndefined();
      expect(clip().overrides).toEqual(overrides);
    } finally {
      rmSync(path('compositions/cut.json'));
    }
  });
});

describe('the lock', () => {
  it('stays read-only while an agent works on the scene', async () => {
    await open('keys', 48);
    await seek(24);
    const px = await perFrame(48);
    // An edit to take back, for the undo below.
    const start = await centre(rowKey('ball', 1));
    await drag(start, { x: start.x + px * 2, y: start.y });
    await soon(() => inFile('ball').tracks[0].keys[1].t).toBeCloseTo(1.666667, 5);
    const edited = inFile('ball');

    const claimed = await studio.server.queue.create({ selection: { sceneId: 'keys', from: 0, to: 48 }, frame: 0, prompt: 'change it', references: [] });
    await studio.server.queue.claim(claimed.id, 'test-session');
    await page.waitForFunction(() => !document.querySelector('.bar-edge'));

    const at = await centre(rowKey('ball', 1));
    await drag(at, { x: at.x + px * 3, y: at.y });
    await soon(notice).toMatch(/agent is working/i);
    const scale = await canvasScale();
    const from = await onCanvas(320, 180);
    await drag(from, { x: from.x + 40 * scale, y: from.y });
    await select('ball');
    await rowKey('ball', 1).click();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(300);
    expect(inFile('ball')).toEqual(edited);

    const refused = await fetch(`${studio.base}__studio/layers`, {
      method: 'POST',
      headers: { ...studio.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'keys', layer: 'ball', set: { params: { x: 1 } } }),
    });
    expect(refused.status).toBe(409);

    await studio.server.queue.complete(claimed.id, 'done', 'changed');
    await page.waitForFunction(() => document.querySelector('.bar-edge'));
    await page.keyboard.press('Meta+z');
    await soon(() => inFile('ball')).toEqual(ball);
  });

  it('refuses an edit the validator refuses, a bad field, and a layer that is not there', async () => {
    const post = (body: unknown) =>
      fetch(`${studio.base}__studio/layers`, { method: 'POST', headers: { ...studio.auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ scene: 'keys', layer: 'ball', set: { rig: 'star' } })).status).toBe(400);
    expect((await post({ scene: 'keys', layer: 'nope', set: { params: {} } })).status).toBe(409);
    expect((await post({ scene: 'keys', layer: 'ball', set: { tracks: [{ param: 'x', keys: [{ t: 2, v: 1 }, { t: 1, v: 2 }] }] } })).status).toBe(409);
    expect(inFile('ball')).toEqual(ball);
  });

  it('ends the history when the file changes from outside', async () => {
    await open('keys', 48);
    const px = await perFrame(48);
    const at = await centre(rowKey('ball', 1));
    await drag(at, { x: at.x + px * 3, y: at.y });
    await soon(() => inFile('ball').tracks[0].keys[1].t).toBe(1.75);
    await page.waitForTimeout(300);
    write('scenes/keys.json', { ...read(), markers: [{ t: 3, label: 'moved' }] });
    await page.locator('.marker button', { hasText: 'moved' }).waitFor();
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(300);
    expect(inFile('ball').tracks[0].keys[1].t).toBe(1.75);
  });
});
