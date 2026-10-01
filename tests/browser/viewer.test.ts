/**
 * The viewer (index.html) in Playwright's headless Chromium, found by
 * accessible name, so these tests describe behaviour rather than markup. They
 * pin down what the viewer does, and the Svelte port (ADR 0002) must keep it.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/render/studio';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

let browser: Browser;
let studio: TestStudio;
let base: string;
const BROKEN = join(ROOT, 'scenes', 'test-tmp-broken.json');

beforeAll(async () => {
  rmSync(BROKEN, { force: true });
  studio = await startStudio({ hmr: true });
  base = studio.base;
  browser = await launchBrowser();
});

afterAll(async () => {
  rmSync(BROKEN, { force: true });
  await browser?.close();
  await studio?.close();
});

async function open(query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${base}${query}#token=${studio.token}`);
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined);
  return page;
}

const readout = (page: Page) => page.getByRole('status', { name: 'Frame number' }).textContent();
const timecode = (page: Page) => page.getByRole('status', { name: 'Timecode' }).textContent();
const layer = (page: Page) => page.getByRole('status', { name: 'Selected layer' }).textContent();
const range = (page: Page) => page.getByRole('status', { name: 'Frame range' }).textContent();
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Studio' });
/** The scene the sidebar marks as the one on screen. */
const currentScene = (page: Page) => sidebar(page).locator('[aria-current="page"]').getAttribute('data-key');

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
    expect(await currentScene(page)).toBe('shapes-test');
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

  it('seeks with the scrubber and switches scenes from the sidebar', async () => {
    const page = await open('?scene=shapes-test&frame=0');
    await page.getByRole('slider', { name: 'Frame' }).fill('30');
    await expect.poll(() => readout(page)).toBe('frame 30 of 72');
    await sidebar(page).getByRole('button', { name: 'hello', exact: true }).click();
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
    await expect.poll(() => layer(page)).toBe('No layer');
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

describe('projects (ADR 0007)', () => {
  type Shots = { layerId: string; scene: string; from: number; to: number }[];
  const shots = (page: Page) => page.evaluate(() => (window as unknown as { studio: { shots: Shots } }).studio.shots);
  const url = (page: Page) => new URL(page.url()).searchParams;

  it('lists old films in the sidebar under their names, and opens a film scene by its qualified id', async () => {
    const page = await open(`?scene=${encodeURIComponent('bears-story/pip')}&frame=12`);
    await expect.poll(() => readout(page)).toBe('frame 12 of 48');
    expect(await currentScene(page)).toBe('bears-story/pip');
    const project = sidebar(page).getByRole('group', { name: "Bears' story" });
    expect(await project.locator('button[data-key]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['film', 'meet', 'pip', 'together']);
    // Then a row to convert the film into a project folder (ADR 0013).
    expect(await project.getByRole('listitem').last().getByRole('button').textContent()).toContain('Convert to a project');
    expect(await project.getByRole('button', { name: 'film', exact: true }).textContent()).toContain('main');
    // Loose scenes stay outside the project.
    expect(await sidebar(page).getByRole('region', { name: 'Scenes' }).getByRole('button', { name: 'bear-test', exact: true }).count()).toBe(1);
    expect(await page.title()).toBe('bears-story/pip · Frame Studio');
    await page.close();
  });

  it("shows each shot's span on the film's scrubber, and a click selects the shot", async () => {
    const page = await open(`?scene=${encodeURIComponent('bears-story/film')}&frame=0`);
    await expect.poll(() => readout(page)).toBe('frame 0 of 144');
    expect(await shots(page)).toEqual([
      { layerId: 'meet', scene: 'bears-story/meet', from: 0, to: 36 },
      { layerId: 'pip', scene: 'bears-story/pip', from: 36, to: 84 },
      { layerId: 'together', scene: 'bears-story/together', from: 72, to: 132 },
      { layerId: 'again', scene: 'bears-story/meet', from: 120, to: 144 },
    ]);
    const bands = page.getByRole('group', { name: 'Shots' }).getByRole('button');
    expect((await bands.allTextContents()).map((t) => t.trim())).toEqual(['meet', 'pip', 'together', 'meet']);
    expect(await bands.nth(3).getAttribute('aria-label')).toBe('meet (layer again)');
    await bands.nth(1).click();
    expect(await bands.nth(1).getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => layer(page)).toBe('pip');
    await expect.poll(() => range(page)).toBe('[36, 84)');
    await expect.poll(() => page.getByRole('button', { name: 'Open shot' }).isVisible()).toBe(true);
    await page.close();
  });

  it('opens a shot at the matching frame from a double-click, and the link goes back to the same moment', async () => {
    const page = await open(`?scene=${encodeURIComponent('bears-story/film')}&frame=50`);
    await expect.poll(() => readout(page)).toBe('frame 50 of 144');
    // Film frame 50 is pip's frame 14 (pip starts at film frame 36).
    const at = await scenePoint(page, 960, 900);
    await page.mouse.dblclick(at.x, at.y);
    await expect.poll(() => url(page).get('scene')).toBe('bears-story/pip');
    await expect.poll(() => readout(page)).toBe('frame 14 of 48');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => readout(page)).toBe('frame 15 of 48');
    await page.getByRole('button', { name: 'Back to bears-story/film' }).click();
    await expect.poll(() => url(page).get('scene')).toBe('bears-story/film');
    await expect.poll(() => readout(page)).toBe('frame 51 of 144');
    await expect.poll(() => layer(page)).toBe('pip');
    await page.close();
  });

  it('opens a shot from a double-click on its band, even though the first click reflows the controls', async () => {
    const page = await open(`?scene=${encodeURIComponent('bears-story/film')}&frame=0`);
    await expect.poll(() => readout(page)).toBe('frame 0 of 144');
    await page.getByRole('group', { name: 'Shots' }).getByRole('button', { name: 'meet (layer again)' }).dblclick();
    await expect.poll(() => url(page).get('scene')).toBe('bears-story/meet');
    await expect.poll(() => readout(page)).toBe('frame 12 of 48');
    await page.close();
  });

  it('goes back through the cut as it is now, if it moved while the shot was open', async () => {
    const film = join(ROOT, 'projects/bears-story/film.json');
    const original = readFileSync(film, 'utf8');
    const page = await open(`?scene=${encodeURIComponent('bears-story/film')}&frame=50`);
    try {
      await expect.poll(() => readout(page)).toBe('frame 50 of 144');
      await page.evaluate(() => (window as unknown as { studio: { openShot(id: string): void } }).studio.openShot('pip'));
      await expect.poll(() => readout(page)).toBe('frame 14 of 48');
      // pip now starts at 4 s rather than 3 s.
      const moved = JSON.parse(original) as { layers: { id: string; start?: number }[] };
      moved.layers.find((l) => l.id === 'pip')!.start = 4;
      writeFileSync(film, `${JSON.stringify(moved, null, 2)}\n`);
      await expect.poll(() => page.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors.length)).toBe(0);
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Back to bears-story/film' }).click();
      await expect.poll(() => readout(page)).toBe('frame 62 of 144');
    } finally {
      writeFileSync(film, original);
      await page.close();
    }
  });

  it('opens the selected shot with Open shot, at its first frame shown when the playhead is outside it', async () => {
    const page = await open(`?scene=${encodeURIComponent('bears-story/film')}&frame=10`);
    await expect.poll(() => readout(page)).toBe('frame 10 of 144');
    await page.getByRole('group', { name: 'Shots' }).getByRole('button').nth(3).click();
    await page.getByRole('button', { name: 'Open shot' }).click();
    await expect.poll(() => url(page).get('scene')).toBe('bears-story/meet');
    // "again" places meet from its 1 s mark: meet's frame 12.
    await expect.poll(() => readout(page)).toBe('frame 12 of 48');
    await page.close();
  });
});

describe('export (ADR 0008)', () => {
  it('exports the selected range as a GIF from the Export panel, with progress, into out/', async () => {
    const page = await open('?scene=shapes-test&frame=0');
    await expect.poll(() => readout(page)).toBe('frame 0 of 72');
    await page.evaluate(() => (window as unknown as { studio: { setRange(a: number, b: number): void } }).studio.setRange(0, 12));
    const file = join(ROOT, 'out/shapes-test/shapes-test-00000-00012.gif');
    rmSync(file, { force: true });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Export' });
    await panel.getByRole('radio', { name: 'GIF' }).check();
    await panel.getByRole('checkbox', { name: /Only frames \[0, 12\)/ }).check();
    await expect.poll(() => panel.getByRole('checkbox', { name: 'GIFs are silent' }).isDisabled()).toBe(true);
    await panel.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(() => panel.getByRole('status').textContent(), { timeout: 60_000 }).toMatch(/Saved shapes-test-00000-00012\.gif/);
    const gif = readFileSync(file);
    expect(gif.subarray(0, 6).toString()).toBe('GIF89a');
    rmSync(file, { force: true });
    await page.close();
  });
});

describe('what the dev server serves (ADR 0008)', () => {
  it("serves the viewer's code, and nothing else of the repo: no tokens, no queue", async () => {
    const status = async (path: string) => (await fetch(`${base}${path.replace(/^\//, '')}`)).status;
    expect(await status('/')).toBe(200);
    expect(await status('/src/viewer/main.ts')).toBe(200);
    expect(await status('/boot-guard.js')).toBe(200);
    for (const path of ['/.frame-studio/selection.json', '/.git/HEAD', '/scenes/hello.json', '/package.json', `/@fs${ROOT}/.frame-studio/selection.json`]) {
      expect(await status(path), path).toBeGreaterThanOrEqual(400);
    }
  });
});
