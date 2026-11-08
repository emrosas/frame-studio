/**
 * How a thread reads in the agent panel: the scripted test agent answers in
 * Markdown, and the panel draws it as T3 Code's chat does, with headings,
 * lists, code blocks with Copy, tables and safe links, and its steps in a work
 * log showing the newest few. All in Playwright's headless Chromium, so a run
 * never takes focus. THREAD_SHOTS=<dir> also saves the panel in light and dark.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/render/studio';
import type { StudioRequest } from '../../src/studio/protocol';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

const SCENE = `test-tmp-thread-view-${process.pid}`;
const SCENE_FILE = join(ROOT, 'scenes', `${SCENE}.json`);
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-thread-view-'));

const ANSWER = [
  '## What I changed',
  '',
  'The ball now **eases in** over frames 12 to 24, and `fill` is `#1a2a99`. See [the docs](https://example.com/docs) or [this](javascript:alert(1)).',
  '',
  '- Moved the `x` key to *0:01*',
  '- Kept the shadow:',
  '  1. softer edge',
  '  2. same offset',
  '- [x] checked the contact sheet',
  '',
  '```ts',
  "const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // a long line that has to scroll sideways rather than wrap",
  '```',
  '',
  '| Frame | x | Note |',
  '|:--|--:|:-:|',
  '| 12 | 400 | start |',
  '| 24 | 1400 | end |',
  '',
  '> A quote, for something the agent read.',
  '',
  'Raw <b>tags</b> stay text.',
].join('\n');

let studio: TestStudio;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  process.env.FRAME_STUDIO_DIR = STUDIO;
  process.env.FRAME_STUDIO_FAKE_AGENT = '1';
  const hello = JSON.parse(readFileSync(join(ROOT, 'scenes/hello.json'), 'utf8'));
  writeFileSync(SCENE_FILE, `${JSON.stringify({ ...hello, id: SCENE }, null, 2)}\n`);
  const look = (id: string) => ({ tool: 'get_scene', args: { id } });
  writeFileSync(
    join(STUDIO, 'fake-agent.json'),
    JSON.stringify({ scripts: [{ match: 'ease the ball', steps: [{ say: 'Looking at the scene first.\n\n' }, look(SCENE), { tool: 'list_rigs' }, look('hello'), look(SCENE), { tool: 'list_generators' }, look(SCENE), { say: ANSWER }] }] }),
  );
  studio = await startStudio({ hmr: true, agents: true });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  delete process.env.FRAME_STUDIO_DIR;
  delete process.env.FRAME_STUDIO_FAKE_AGENT;
  rmSync(SCENE_FILE, { force: true });
  rmSync(STUDIO, { recursive: true, force: true });
});

async function sendTurn(prompt: string): Promise<StudioRequest> {
  const res = await fetch(`${studio.server.url}/__studio/requests`, {
    method: 'POST',
    headers: { ...studio.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection: { sceneId: SCENE, layerId: 'ball', from: 12, to: 24 }, frame: 12, prompt, references: [], agent: 'fake', settings: { access: 'studio' } }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { request: StudioRequest }).request;
}

describe('a thread in the agent panel', () => {
  it("draws the agent's Markdown and its steps as T3 Code's chat does", async () => {
    const request = await sendTurn('ease the ball in over the range, and tell me what you changed');
    await page.goto(studio.paired(`?scene=${SCENE}&frame=12`));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined);
    const nav = page.getByRole('navigation', { name: 'Studio' });
    await nav.getByRole('button', { name: /^Threads/ }).click();
    await nav.getByRole('article', { name: `Request ${request.id}` }).getByRole('button').click();
    const thread = page.getByRole('complementary', { name: 'Agent' }).getByRole('region', { name: `Request ${request.id}` });
    const turn = thread.getByRole('listitem', { name: 'Turn 1' });
    await expect.poll(() => thread.getByRole('status', { name: 'Request status' }).textContent(), { timeout: 30_000 }).toContain('Your turn');
    const md = turn.locator('.work-text .md').last();

    // Headings, emphasis and inline code.
    expect(await md.getByRole('heading', { level: 2, name: 'What I changed' }).count()).toBe(1);
    expect(await md.locator('strong').first().textContent()).toBe('eases in');
    expect(await md.locator(':scope > p code').allTextContents()).toEqual(['fill', '#1a2a99']);
    // A link to the web opens outside; a script link is only text.
    const docs = md.getByRole('link', { name: 'the docs' });
    expect(await docs.getAttribute('href')).toBe('https://example.com/docs');
    expect(await docs.getAttribute('target')).toBe('_blank');
    expect(await md.getByRole('link', { name: 'this' }).count()).toBe(0);
    expect(await md.locator('a[href^="javascript"]').count()).toBe(0);
    // Lists, nested, and a task.
    expect(await md.locator('ul > li').count()).toBe(3);
    expect(await md.locator('ul > li ol > li').allTextContents()).toEqual(['softer edge', 'same offset']);
    expect(await md.getByRole('checkbox', { name: 'Done' }).isChecked()).toBe(true);
    // A code block with its language and Copy, scrolling sideways rather than wrapping.
    const code = md.locator('figure.md-code');
    expect(await code.locator('.md-lang').textContent()).toBe('ts');
    expect(await code.getByRole('button', { name: 'Copy code' }).count()).toBe(1);
    const pre = code.locator('pre');
    expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // A table with its alignment, a quote, and raw HTML as text.
    expect(await md.locator('th').allTextContents()).toEqual(['Frame', 'x', 'Note']);
    expect(await md.locator('td').nth(1).evaluate((el) => getComputedStyle(el).textAlign)).toBe('right');
    expect(await md.locator('blockquote').textContent()).toContain('A quote');
    expect(await md.locator('b').count()).toBe(0);
    expect(await md.textContent()).toContain('Raw <b>tags</b> stay text.');
    // Nothing spills out of the panel sideways.
    expect(await thread.locator('.panel-body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // Six steps: the newest four show, and the rest are a click away.
    const log = turn.getByRole('region', { name: 'Steps' });
    expect(await log.locator('.work-log-head > span').textContent()).toBe('6 steps');
    expect(await log.locator('.work-step:visible').count()).toBe(4);
    expect(await log.locator('.work-step.is-done').count()).toBe(6);
    expect(await log.locator('.work-step').first().textContent()).toContain('Studio: get_scene');

    const shots = process.env.THREAD_SHOTS;
    const panel = page.getByRole('complementary', { name: 'Agent' });
    if (shots) {
      await page.mouse.move(0, 0);
      await panel.screenshot({ path: join(shots, 'thread-light.png') });
    }
    await log.getByRole('button', { name: 'Show 2 more' }).click();
    expect(await log.locator('.work-step:visible').count()).toBe(6);
    await log.getByRole('button', { name: 'Show less' }).click();
    expect(await log.locator('.work-step:visible').count()).toBe(4);

    if (shots) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await panel.screenshot({ path: join(shots, 'thread-dark.png') });
      await thread.locator('.panel-body').evaluate((el) => (el.scrollTop = 0));
      await panel.screenshot({ path: join(shots, 'thread-dark-top.png') });
      await page.emulateMedia({ colorScheme: 'light' });
      await thread.locator('.panel-body').evaluate((el) => (el.scrollTop = 0));
      await panel.screenshot({ path: join(shots, 'thread-light-top.png') });
    }
  });
});
