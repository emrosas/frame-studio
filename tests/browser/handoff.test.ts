/**
 * M6: the selection handoff in the viewer (ADR 0003), end to end. The test
 * plays the agent's side through the file queue, as the MCP server would, on
 * a throwaway handoff folder and a copy of bear-test, so no real queue or
 * scene is touched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CurrentSelection } from '../../src/studio/protocol';
import { launchBrowser, ROOT, startVite } from '../../tools/render/studio';
import { StudioQueue } from '../../tools/studio/queue';

const ID = `test-tmp-handoff-${process.pid}`;
const SCENE_FILE = join(ROOT, 'scenes', `${ID}.json`);
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-viewer-handoff-'));
const agent = new StudioQueue(STUDIO, async () => SCENE_FILE);
const uploaded: string[] = [];

let vite: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let original: string;

beforeAll(async () => {
  process.env.FRAME_STUDIO_DIR = STUDIO;
  const scene = JSON.parse(readFileSync(join(ROOT, 'scenes/bear-test.json'), 'utf8'));
  original = `${JSON.stringify({ ...scene, id: ID }, null, 2)}\n`;
  writeFileSync(SCENE_FILE, original);
  vite = await startVite({ watch: true, hmr: true });
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await context.newPage();
  await page.goto(`${vite.resolvedUrls!.local[0]}?scene=${ID}&frame=60`);
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 96);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await vite?.close();
  delete process.env.FRAME_STUDIO_DIR;
  rmSync(SCENE_FILE, { force: true });
  rmSync(STUDIO, { recursive: true, force: true });
  for (const path of uploaded) rmSync(join(ROOT, path), { force: true });
});

async function clickScene(x: number, y: number, modifiers: ('Alt' | 'Shift')[] = []): Promise<void> {
  const at = await page.evaluate(
    ([sx, sy]) => {
      const studio = (window as unknown as { studio: { canvas: HTMLCanvasElement } }).studio;
      const r = studio.canvas.getBoundingClientRect();
      return { x: r.left + (sx * r.width) / 1920, y: r.top + (sy * r.height) / 1080 };
    },
    [x, y],
  );
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(at.x, at.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** Waits until the locator's text contains `text` (Playwright's expect matchers belong to its own runner). */
async function expectText(locator: ReturnType<Page['locator']>, text: string): Promise<void> {
  await expect.poll(async () => (await locator.count()) > 0 && ((await locator.first().textContent()) ?? ''), { timeout: 5000 }).toContain(text);
}

const panel = () => page.getByRole('complementary', { name: 'Requests' });
const request = (id: number) => panel().getByRole('article', { name: `Request ${id}` });
const readSelection = () => (existsSync(join(STUDIO, 'selection.json')) ? (JSON.parse(readFileSync(join(STUDIO, 'selection.json'), 'utf8')) as CurrentSelection) : null);

/** The smallest valid PNG: one opaque pixel. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('sending a request from the viewer', () => {
  it('publishes the current selection, with the click point, after a short pause', async () => {
    await clickScene(760, 500);
    await expect.poll(readSelection, { timeout: 3000 }).toMatchObject({ sceneId: ID, layerId: 'bruno', from: 0, to: 96, frame: 60 });
    const point = readSelection()!.point!;
    expect(Math.abs(point.x - 760) + Math.abs(point.y - 500), JSON.stringify(point)).toBeLessThanOrEqual(6);
    await page.keyboard.press('i');
    await expect.poll(() => readSelection()?.from, { timeout: 3000 }).toBe(60);
  });

  it('queues the prompt with its selection and a reference, and copies a line for the agent', async () => {
    await panel().getByRole('textbox', { name: 'Prompt' }).fill('make bruno look sad here');
    await panel().locator('input[type=file]').setInputFiles({ name: 'Sad Bear.png', mimeType: 'image/png', buffer: PNG });
    await panel().getByRole('img', { name: 'Sad Bear.png' }).waitFor();
    await panel().getByRole('button', { name: 'Send to agent' }).click();
    await expectText(panel().getByRole('status'), 'Request #1 queued');

    const [sent] = await agent.list();
    uploaded.push(...sent.references);
    expect(sent).toMatchObject({ id: 1, status: 'pending', prompt: 'make bruno look sad here', frame: 60 });
    expect(Math.abs(sent.point!.x - 760) + Math.abs(sent.point!.y - 500)).toBeLessThanOrEqual(6);
    expect(sent.selection).toEqual({ sceneId: ID, layerId: 'bruno', from: 60, to: 96 });
    expect(sent.references).toHaveLength(1);
    expect(sent.references[0]).toMatch(/^references\/\d{4}-\d{2}-\d{2}-sad-bear\.png$/);
    expect(readFileSync(join(ROOT, sent.references[0]))).toEqual(PNG);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Frame Studio request #1: "make bruno look sad here" .*get_request \(id 1\)/);
    await expectText(request(1), 'waiting');
    expect(await panel().getByRole('textbox', { name: 'Prompt' }).inputValue()).toBe('');
  });
});

describe('following a request', () => {
  it('shows the agent working, then a notice whose View loops the range', async () => {
    const claimed = await agent.claimNext('test-agent');
    expect(claimed?.id).toBe(1);
    await expectText(request(1), 'in progress');

    // The agent edits the scene: bruno's body turns blue over his range.
    const scene = JSON.parse(readFileSync(SCENE_FILE, 'utf8'));
    scene.layers.find((l: { id: string }) => l.id === 'bruno').overrides.push({ from: 72, to: 96, params: { body: '#3355ff' } });
    writeFileSync(SCENE_FILE, `${JSON.stringify(scene, null, 2)}\n`);
    await agent.complete(1, 'done', 'turned bruno blue over frames 72 to 96');

    await expectText(request(1), 'turned bruno blue over frames 72 to 96');
    const notice = page.getByRole('status', { name: 'Request finished' });
    await expectText(notice, '#1 done');
    await page.keyboard.press('Escape'); // clear the layer first, so View has something to restore
    await notice.getByRole('button', { name: 'View' }).click();
    await expect.poll(() => notice.count()).toBe(0);
    await expect.poll(() => page.getByRole('status', { name: 'Selected layer' }).textContent()).toBe('bruno');
    await expect.poll(() => page.getByRole('status', { name: 'Frame range' }).textContent()).toBe('[60, 96)');
    const frames = new Set<number>();
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(100);
      frames.add(await page.evaluate(() => (window as unknown as { studio: { frame: number; playing: boolean } }).studio.frame));
    }
    await page.keyboard.press('Space');
    expect([...frames].every((f) => f >= 60 && f < 96), [...frames].join(',')).toBe(true);
  });

  it('reverts the newest finished request, restoring the scene file exactly', async () => {
    await request(1).getByRole('button', { name: 'Revert' }).click();
    await expectText(request(1), 'reverted');
    expect(readFileSync(SCENE_FILE, 'utf8')).toBe(original);
  });

  it('tries again with an edited prompt as the next attempt', async () => {
    // A fresh finished request to retry.
    await agent.create({ selection: { sceneId: ID, layerId: 'pip', from: 0, to: 24 }, frame: 0, prompt: 'make pip wave', references: [] });
    await agent.claimNext('test-agent');
    await agent.complete(2, 'failed', 'could not find a wave that reads at 12 fps');
    await expectText(request(2), 'failed');
    await request(2).getByRole('button', { name: 'Try again' }).click();
    const retry = request(2).getByRole('textbox', { name: 'Prompt for the next attempt' });
    expect(await retry.inputValue()).toBe('make pip wave');
    await retry.fill('make pip wave with the left paw, slower');
    await request(2).getByRole('button', { name: /Revert and queue attempt 2/ }).click();
    await expectText(request(3), 'attempt 2');
    expect(await agent.get(3)).toMatchObject({ prompt: 'make pip wave with the left paw, slower', attempt: 2, retryOf: 2, status: 'pending' });
    expect((await agent.get(2)).status).toBe('reverted');
  });

  it('cancels a waiting request and clears finished ones', async () => {
    await request(3).getByRole('button', { name: 'Cancel' }).click();
    await expectText(request(3), 'cancelled');
    await panel().getByRole('button', { name: 'Clear finished' }).click();
    await expect.poll(() => panel().getByRole('article').count()).toBe(0);
    expect(await agent.list()).toEqual([]);
  });
});
