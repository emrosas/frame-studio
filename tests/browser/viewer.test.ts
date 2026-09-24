/**
 * The viewer (index.html) in Playwright's headless Chromium, found by
 * accessible name, so these tests describe behaviour rather than markup. They
 * pin down what the viewer does, and the Svelte port (ADR 0002) must keep it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, ROOT, startVite } from '../../tools/render/studio';

let browser: Browser;
let vite: ViteDevServer;
let base: string;
const BROKEN = join(ROOT, 'scenes', 'test-tmp-broken.json');

beforeAll(async () => {
  rmSync(BROKEN, { force: true });
  vite = await startVite({ watch: true, hmr: true });
  base = vite.resolvedUrls!.local[0];
  browser = await launchBrowser();
});

afterAll(async () => {
  rmSync(BROKEN, { force: true });
  await browser?.close();
  await vite?.close();
});

async function open(query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${base}${query}`);
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined);
  return page;
}

const readout = (page: Page) => page.getByRole('status', { name: 'Frame number' }).textContent();
const timecode = (page: Page) => page.getByRole('status', { name: 'Timecode' }).textContent();
const layer = (page: Page) => page.getByRole('status', { name: 'Selected layer' }).textContent();
const range = (page: Page) => page.getByRole('status', { name: 'Frame range' }).textContent();

/** Viewport position of scene pixel (x, y) on the canvas. */
async function scenePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const studio = (window as unknown as { studio: { canvas: HTMLCanvasElement; scene: { size: [number, number] } } }).studio;
      const r = studio.canvas.getBoundingClientRect();
      return { x: r.left + (sx * r.width) / studio.scene.size[0], y: r.top + (sy * r.height) / studio.scene.size[1] };
    },
    [x, y],
  );
}

describe('the viewer', () => {
  it('opens the scene and frame in the URL', async () => {
    const page = await open('?scene=shapes-test&frame=12');
    await expect.poll(() => readout(page)).toBe('frame 12 of 72');
    await expect.poll(() => timecode(page)).toBe('00:01:00 / 00:06:00');
    expect(await page.getByRole('combobox', { name: 'Scene' }).inputValue()).toBe('shapes-test');
    expect(await page.title()).toBe('shapes-test · Frame Studio');
    await page.close();
  });

  it('plays and pauses from the button and with Space', async () => {
    const page = await open('?scene=shapes-test&frame=0');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => readout(page), { timeout: 3000 }).not.toBe('frame 0 of 72');
    await page.keyboard.press('Space');
    await expect.poll(() => page.getByRole('button', { name: 'Play' }).count()).toBe(1);
    const paused = await readout(page);
    await page.waitForTimeout(300);
    await expect.poll(() => readout(page)).toBe(paused);
    await page.close();
  });

  it('steps with the arrow keys, a second with Shift, and jumps with Home and End', async () => {
    const page = await open('?scene=shapes-test&frame=10');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => readout(page)).toBe('frame 11 of 72');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => readout(page)).toBe('frame 9 of 72');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => readout(page)).toBe('frame 21 of 72');
    await page.keyboard.press('End');
    await expect.poll(() => readout(page)).toBe('frame 71 of 72');
    await page.keyboard.press('Home');
    await expect.poll(() => readout(page)).toBe('frame 0 of 72');
    await page.close();
  });

  it('seeks with the scrubber and switches scenes with the picker', async () => {
    const page = await open('?scene=shapes-test&frame=0');
    await page.getByRole('slider', { name: 'Frame' }).fill('30');
    await expect.poll(() => readout(page)).toBe('frame 30 of 72');
    await page.getByRole('combobox', { name: 'Scene' }).selectOption('hello');
    await expect.poll(() => readout(page)).toBe('frame 0 of 72');
    expect(await page.getByRole('status', { name: 'Frame rate' }).textContent()).toMatch(/^24 fps/);
    await expect.poll(() => page.url()).toContain('scene=hello');
    await page.close();
  });

  it('selects the layer under a click, the part with Alt, and clears with Escape', async () => {
    const page = await open('?scene=bear-test&frame=60');
    const bruno = await scenePoint(page, 760, 500);
    await page.mouse.click(bruno.x, bruno.y);
    await expect.poll(() => layer(page)).toBe('bruno');
    await expect.poll(() => page.url()).toContain('layer=bruno');
    await page.keyboard.down('Alt');
    await page.mouse.click(bruno.x, bruno.y);
    await page.keyboard.up('Alt');
    await expect.poll(() => layer(page)).toMatch(/^bruno › \w+/);
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await expect.poll(() => layer(page)).toBe('none');
    await page.close();
  });

  it('sets a frame range with I and O and with typed timecodes', async () => {
    const page = await open('?scene=bear-test&frame=12');
    await page.keyboard.press('i');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('o');
    await expect.poll(() => range(page)).toBe('[12, 27)');
    const to = page.getByRole('textbox', { name: /^To frame/ });
    await to.fill('00:02:00');
    await to.press('Enter');
    await expect.poll(() => range(page)).toBe('[12, 24)');
    await expect.poll(() => page.url()).toMatch(/from=12&to=24/);
    await page.close();
  });

  it('keeps what you type in a range field while playback runs, and a rejected entry and its error', async () => {
    const page = await open('?scene=shapes-test&frame=0');
    await page.getByRole('button', { name: 'Play' }).click();
    const from = page.getByRole('textbox', { name: /^From frame/ });
    await from.click();
    await from.pressSequentially('00:01', { delay: 60 });
    await page.waitForTimeout(400);
    expect(await from.inputValue()).toBe('00:01');
    await from.fill('nonsense');
    await from.press('Enter');
    await page.waitForTimeout(600);
    expect(await from.inputValue()).toBe('nonsense');
    expect(await from.getAttribute('aria-invalid')).toBe('true');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await page.close();
  });

  it('loops playback inside the selected range', async () => {
    const page = await open('?scene=shapes-test&frame=0&from=12&to=18');
    await page.getByRole('button', { name: 'Play' }).click();
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(100);
      seen.add(await page.evaluate(() => (window as unknown as { studio: { frame: number } }).studio.frame));
    }
    await page.keyboard.press('Space');
    expect([...seen].every((f) => f >= 12 && f < 18), [...seen].join(',')).toBe(true);
    expect(seen.size).toBeGreaterThan(3);
    await page.close();
  });

  it('says a missing scene is missing, then lists what is wrong with it once its file appears', async () => {
    const page = await open('?scene=test-tmp-broken');
    await expect.poll(() => page.getByRole('alert').textContent(), { timeout: 5000 }).toMatch(/not found/);
    // The page is connected for hot updates now, so the new file reaches it.
    writeFileSync(BROKEN, JSON.stringify({ id: 'test-tmp-broken', fps: 0, duration: 1, size: [100, 100], seed: 1, layers: [] }));
    await expect.poll(() => page.getByRole('alert').textContent(), { timeout: 8000 }).toMatch(/fps/);
    await page.close();
  });
});

describe('sound (M7)', () => {
  type Sound = { status: string; muted: boolean; unlocked: boolean; heard: number | null };
  const sound = (page: Page) => page.evaluate(() => (window as unknown as { studio: { sound: Sound } }).studio.sound);
  /** How far the sound reaching the speakers is from the playhead, in seconds. */
  const offBy = (page: Page) =>
    page.evaluate(() => {
      const studio = (window as unknown as { studio: { sound: Sound; frame: number; scene: { fps: number } } }).studio;
      return studio.sound.heard === null ? null : Math.abs(studio.sound.heard - studio.frame / studio.scene.fps);
    });

  it('has no sound button for a silent scene', async () => {
    const page = await open('?scene=shapes-test');
    await expect.poll(() => readout(page)).toBe('frame 0 of 72');
    expect(await page.getByRole('button', { name: /mute/i }).count()).toBe(0);
    expect((await sound(page)).status).toBe('none');
    await page.close();
  });

  it('plays the scene audio in step with the picture, after a seek too, and mutes with M', async () => {
    const page = await open('?scene=audio-test&frame=0');
    await expect.poll(async () => (await sound(page)).status).toBe('ready');
    await expect.poll(() => page.getByRole('button', { name: 'Mute' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Play' }).click(); // a gesture, so the browser lets sound start
    await expect.poll(async () => (await sound(page)).heard, { timeout: 3000 }).not.toBeNull();
    // Within two frames (the frame on screen is floored) plus the resync tolerance.
    const step = 2 / 30 + 0.04;
    await expect.poll(() => offBy(page)).toBeLessThan(step);
    await page.evaluate(() => (window as unknown as { studio: { seek(f: number): number } }).studio.seek(90));
    await expect.poll(() => offBy(page)).toBeLessThan(step);
    await page.keyboard.press('m');
    await expect.poll(async () => (await sound(page)).heard).toBeNull();
    await expect.poll(() => page.getByRole('button', { name: 'Unmute' }).isVisible()).toBe(true);
    await page.keyboard.press('Space');
    await page.close();
  });
});
