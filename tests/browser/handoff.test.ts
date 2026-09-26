/**
 * M6 and M8: the selection handoff in the viewer (ADR 0003, ADR 0006), end to
 * end, with the external agent. The test plays the agent's side through the
 * file queue, as the MCP server would, on a throwaway handoff folder and a
 * copy of bear-test, so no real queue or scene is touched. Requests are
 * threads: the agent works a turn, you reply, revert to any turn, settle.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CurrentSelection } from '../../src/studio/protocol';
import { ROOT } from '../../tools/render/studio';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';
import { StudioQueue } from '../../tools/studio/queue';

const ID = `test-tmp-handoff-${process.pid}`;
const SCENE_FILE = join(ROOT, 'scenes', `${ID}.json`);
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-viewer-handoff-'));
const agent = new StudioQueue(STUDIO, async () => SCENE_FILE);
const uploaded: string[] = [];

let studio: TestStudio;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let original: string;

beforeAll(async () => {
  process.env.FRAME_STUDIO_DIR = STUDIO;
  const scene = JSON.parse(readFileSync(join(ROOT, 'scenes/bear-test.json'), 'utf8'));
  original = `${JSON.stringify({ ...scene, id: ID }, null, 2)}\n`;
  writeFileSync(SCENE_FILE, original);
  studio = await startStudio({ hmr: true });
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await context.newPage();
  await page.goto(studio.paired(`?scene=${ID}&frame=60`));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 96);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await studio?.close();
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

const thread = () => panel().getByRole('region', { name: /^Request \d+$/ });
const turn = (n: number) => thread().getByRole('listitem', { name: `Turn ${n}` });

describe('sending a request from the viewer', () => {
  it('publishes the current selection, with the click point, after a short pause', async () => {
    await clickScene(760, 500);
    await expect.poll(readSelection, { timeout: 3000 }).toMatchObject({ sceneId: ID, layerId: 'bruno', from: 0, to: 96, frame: 60 });
    const point = readSelection()!.point!;
    expect(Math.abs(point.x - 760) + Math.abs(point.y - 500), JSON.stringify(point)).toBeLessThanOrEqual(6);
    await page.keyboard.press('i');
    await expect.poll(() => readSelection()?.from, { timeout: 3000 }).toBe(60);
  });

  it('queues the prompt with its selection and a reference for the external agent, and copies a line for it', async () => {
    await expect.poll(() => panel().getByRole('combobox', { name: 'Agent' }).inputValue()).toBe('external');
    await panel().getByRole('textbox', { name: 'Prompt' }).fill('make bruno look sad here');
    await panel().locator('input[type=file]').setInputFiles({ name: 'Sad Bear.png', mimeType: 'image/png', buffer: PNG });
    await panel().getByRole('img', { name: 'Sad Bear.png' }).waitFor();
    await panel().getByRole('button', { name: 'Send to agent' }).click();
    await expectText(panel().getByRole('status'), 'Request #1 queued');

    const [sent] = await agent.list();
    const ask = sent.turns[0].ask;
    uploaded.push(...ask.references);
    expect(sent).toMatchObject({ id: 1, status: 'pending', agent: 'external', sceneId: ID });
    expect(ask).toMatchObject({ prompt: 'make bruno look sad here', frame: 60 });
    expect(Math.abs(ask.point!.x - 760) + Math.abs(ask.point!.y - 500)).toBeLessThanOrEqual(6);
    expect(ask.selection).toEqual({ sceneId: ID, layerId: 'bruno', from: 60, to: 96 });
    expect(ask.references).toHaveLength(1);
    expect(ask.references[0]).toMatch(/^references\/\d{4}-\d{2}-\d{2}-sad-bear\.png$/);
    expect(readFileSync(join(ROOT, ask.references[0]))).toEqual(PNG);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Frame Studio request #1: "make bruno look sad here" .*get_request \(id 1\)/);
    await expectText(request(1), 'waiting');
    expect(await panel().getByRole('textbox', { name: 'Prompt' }).inputValue()).toBe('');
  });
});

describe('following a thread', () => {
  it('shows the agent working, then a notice whose View opens the thread and loops the range', async () => {
    const claimed = await agent.claimNext('test-agent');
    expect(claimed?.id).toBe(1);
    await expectText(request(1), 'working');

    // The agent edits the scene: bruno's body turns blue over his range.
    const scene = JSON.parse(readFileSync(SCENE_FILE, 'utf8'));
    const bruno = scene.layers.find((l: { id: string }) => l.id === 'bruno');
    (bruno.overrides ??= []).push({ from: 72, to: 96, params: { body: '#3355ff' } });
    writeFileSync(SCENE_FILE, `${JSON.stringify(scene, null, 2)}\n`);
    await agent.complete(1, 'done', 'turned bruno blue over frames 72 to 96');

    await expectText(request(1), 'turned bruno blue over frames 72 to 96');
    await expectText(request(1), 'your turn');
    const notice = page.getByRole('status', { name: 'Request finished' });
    await expectText(notice, '#1 done');
    await page.keyboard.press('Escape'); // clear the layer first, so View has something to restore
    await notice.getByRole('button', { name: 'View' }).click();
    await expect.poll(() => notice.count()).toBe(0);
    await expectText(thread(), 'turned bruno blue over frames 72 to 96');
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

  it('replies in the thread, and the agent works the reply as the next turn', async () => {
    await thread().getByRole('textbox', { name: 'Reply' }).fill('a lighter blue');
    await thread().getByRole('button', { name: 'Reply' }).click();
    await expectText(turn(2), 'a lighter blue');
    await expectText(thread().getByRole('status', { name: 'Request status' }), 'waiting');
    const claimed = await agent.claimNext('test-agent');
    expect(claimed).toMatchObject({ id: 1, turns: [{ status: 'done' }, { status: 'working', ask: { prompt: 'a lighter blue' } }] });
    const scene = JSON.parse(readFileSync(SCENE_FILE, 'utf8'));
    scene.layers.find((l: { id: string }) => l.id === 'bruno').overrides.at(-1).params.body = '#7799ff';
    writeFileSync(SCENE_FILE, `${JSON.stringify(scene, null, 2)}\n`);
    await agent.complete(1, 'done', 'lightened the blue');
    await expectText(turn(2), 'lightened the blue');
  });

  it('reverts to before any turn, restoring the scene file exactly', async () => {
    await turn(1).getByRole('button', { name: 'Revert to before turn 1' }).click();
    await expectText(turn(1), 'reverted');
    await expectText(turn(2), 'reverted');
    expect(readFileSync(SCENE_FILE, 'utf8')).toBe(original);
  });

  it('tries again with an edited prompt as the next attempt', async () => {
    await thread().getByRole('button', { name: 'Back to requests' }).click();
    await agent.create({ selection: { sceneId: ID, layerId: 'pip', from: 0, to: 24 }, frame: 0, prompt: 'make pip wave', references: [] });
    await agent.claimNext('test-agent');
    await agent.complete(2, 'failed', 'could not find a wave that reads at 12 fps');
    await expectText(request(2), 'your turn');
    await request(2).getByRole('button').click();
    await thread().getByRole('button', { name: 'Try again' }).click();
    const retry = thread().getByRole('textbox', { name: 'Prompt for the next attempt' });
    expect(await retry.inputValue()).toBe('make pip wave');
    await retry.fill('make pip wave with the left paw, slower');
    await thread().getByRole('button', { name: 'Revert and try again' }).click();
    await expectText(turn(2), 'attempt 2');
    const two = await agent.get(2);
    expect(two.status).toBe('pending');
    expect(two.turns.map((t) => t.status)).toEqual(['reverted', 'pending']);
    expect(two.turns[1]).toMatchObject({ attempt: 2, ask: { prompt: 'make pip wave with the left paw, slower' } });
  });

  it('cancels a waiting turn, settles a thread, and clears settled ones', async () => {
    await thread().getByRole('button', { name: 'Cancel' }).click();
    await expectText(thread().getByRole('status', { name: 'Request status' }), 'your turn');
    await thread().getByRole('button', { name: 'Settle' }).click();
    await expectText(thread().getByRole('status', { name: 'Request status' }), 'settled');
    await thread().getByRole('button', { name: 'Back to requests' }).click();
    await request(1).getByRole('button').click();
    await thread().getByRole('button', { name: 'Settle' }).click();
    await expectText(thread().getByRole('status', { name: 'Request status' }), 'settled');
    await thread().getByRole('button', { name: 'Back to requests' }).click();
    await panel().getByRole('button', { name: 'Clear settled' }).click();
    await expect.poll(() => panel().getByRole('article').count()).toBe(0);
    expect(await agent.list()).toEqual([]);
  });
});
