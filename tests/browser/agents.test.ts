/**
 * M8: agents inside the studio (ADR 0006), end to end in the viewer, with the
 * scripted test agent (tools/studio/agents/fake.ts). It reaches the real studio
 * tools over the studio server's MCP endpoint, so everything but the model is
 * real: threads, turns, streamed events, frame thumbnails, approvals, question
 * cards (ADR 0011), stop,
 * restarts and one working thread per scene. Runs on a throwaway handoff
 * folder and throwaway scenes.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/render/studio';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';
import { StudioQueue } from '../../tools/studio/queue';
import { readTurnEvents } from '../../tools/studio/agents/runner';

const A = `test-tmp-agents-a-${process.pid}`;
const B = `test-tmp-agents-b-${process.pid}`;
/** A copy of projects/bears-story, for threads on a project's scenes (ADR 0007). */
const P = `test-tmp-agents-${process.pid}`;
const PROJECT_DIR = join(ROOT, 'projects', P);
const sceneFile = (id: string) => (id.includes('/') ? join(ROOT, 'projects', `${id}.json`) : join(ROOT, 'scenes', `${id}.json`));
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-agents-'));
const queue = new StudioQueue(STUDIO, async (id) => sceneFile(id));
const RIG_FILE = join(ROOT, 'src/rigs', `test-tmp-fake-rig-${process.pid}.ts`);
const DOC_FILE = join(ROOT, 'docs', `test-tmp-fake-${process.pid}.md`);

let vite: TestStudio;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const originals = new Map<string, string>();

const ball = (color: string, from = 12, to = 24) => ({ tool: 'apply_to_selection', args: { selection: { sceneId: A, layerId: 'ball', from, to }, patch: { params: { fill: color } } } });

function writeScripts(): void {
  const film = JSON.parse(readFileSync(join(PROJECT_DIR, 'film.json'), 'utf8')) as { layers: Record<string, unknown>[] };
  // The cut from meet to pip moves from 3 s to 3.5 s.
  const recut = film.layers.map((l) => (l.id === 'meet' ? { ...l, out: 3.5 } : l.id === 'pip' ? { ...l, start: 3.5 } : l));
  const project = [
    {
      match: 'project hold',
      steps: [
        { tool: 'apply_to_selection', args: { selection: { sceneId: `${P}/meet`, layerId: 'bruno', from: 0, to: 12 }, patch: { params: { width: 480 } } } },
        { wait: 8000 },
        { say: 'Held meet.' },
      ],
    },
    {
      match: 'project quick',
      steps: [
        { tool: 'apply_to_selection', args: { selection: { sceneId: `${P}/pip`, layerId: 'pip', from: 0, to: 12 }, patch: { params: { x: 700 } } } },
        { say: 'Moved pip.' },
      ],
    },
    { match: 'project recut', steps: [{ tool: 'update_scene', args: { id: `${P}/film`, patch: { layers: recut } } }, { say: 'Recut.' }] },
    {
      match: 'project recast',
      steps: [
        { tool: 'update_project', args: { id: P, patch: { cast: { bruno: { params: { body: '#d8b48a' } } } } } },
        { tool: 'apply_to_selection', args: { selection: { sceneId: `${P}/film`, layerId: 'together', from: 90, to: 96 }, patch: { params: { scale: 1.1 } } } },
        { say: 'Recast.' },
      ],
    },
  ];
  const scripts = [
    ...project,
    {
      match: 'make the ball blue',
      steps: [
        { say: 'Looking at the ball. ' },
        { tool: 'render_frame', args: { sceneId: A, frame: 12, maxWidth: 320 } },
        ball('#3355ff'),
        { say: 'Made the ball blue over frames 12 to 24.' },
      ],
    },
    { match: 'a bit darker', steps: [ball('#1a2a99'), { say: 'Darker now.' }] },
    {
      match: 'write a rig and run the tests',
      steps: [
        { write: { path: `src/rigs/test-tmp-fake-rig-${process.pid}.ts`, content: 'export {};\n' } },
        { write: { path: `docs/test-tmp-fake-${process.pid}.md`, content: 'notes\n' } },
        { command: 'npm test' },
        { say: 'Wrote the rig.' },
      ],
    },
    {
      match: 'ask about the title',
      steps: [
        {
          ask: [
            {
              id: 'font',
              header: 'Font',
              question: 'Which typeface for the title?',
              options: [
                { label: 'Fraunces (Recommended)', description: 'A warm old-style serif', preview: 'Fraunces\nAa Bb Cc' },
                { label: 'Inter Display', description: 'A heavy sans' },
              ],
            },
            { id: 'extras', header: 'Extras', question: 'What else goes with it?', multiSelect: true, options: [{ label: 'A kicker' }, { label: 'A rule' }, { label: 'A date' }] },
          ],
        },
        { say: 'Set the title.' },
      ],
    },
    { match: 'ask one thing', steps: [{ ask: [{ id: 'colour', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, { say: 'Painted.' }] },
    { match: 'ask and wait', steps: [{ wait: 1500 }, { ask: [{ id: 'colour', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, { say: 'never' }] },
    { match: 'slow edit', steps: [ball('#ff8800'), { say: 'Orange so far.' }, { wait: 20000 }, { say: 'never' }] },
    { match: 'long wait', steps: [{ say: 'Waiting.' }, { wait: 20000 }, { say: 'never' }] },
    { match: 'slow', steps: [{ wait: 1500 }, { say: 'Took my time.' }] },
  ];
  writeFileSync(join(STUDIO, 'fake-agent.json'), JSON.stringify({ scripts }));
}

async function openViewer(): Promise<void> {
  await page.goto(vite.paired(`?scene=${A}&frame=12`));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 72);
}

async function startServer(): Promise<void> {
  vite = await startStudio({ hmr: true, agents: true });
}

beforeAll(async () => {
  cpSync(join(ROOT, 'projects/bears-story'), PROJECT_DIR, { recursive: true });
  process.env.FRAME_STUDIO_DIR = STUDIO;
  process.env.FRAME_STUDIO_FAKE_AGENT = '1';
  const hello = JSON.parse(readFileSync(join(ROOT, 'scenes/hello.json'), 'utf8'));
  for (const id of [A, B]) {
    const text = `${JSON.stringify({ ...hello, id }, null, 2)}\n`;
    originals.set(id, text);
    writeFileSync(sceneFile(id), text);
  }
  writeScripts();
  await startServer();
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  await openViewer();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await vite?.close();
  delete process.env.FRAME_STUDIO_DIR;
  delete process.env.FRAME_STUDIO_FAKE_AGENT;
  for (const id of [A, B]) rmSync(sceneFile(id), { force: true });
  rmSync(RIG_FILE, { force: true });
  rmSync(DOC_FILE, { force: true });
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  rmSync(STUDIO, { recursive: true, force: true });
});

async function expectText(locator: ReturnType<Page['locator']>, text: string, timeout = 15000): Promise<void> {
  await expect.poll(async () => (await locator.count()) > 0 && ((await locator.first().textContent()) ?? ''), { timeout }).toContain(text);
}

const panel = () => page.getByRole('complementary', { name: 'Agent' });
const thread = () => panel().getByRole('region', { name: /^Request \d+$/ });
const turn = (n: number) => thread().getByRole('listitem', { name: `Turn ${n}` });
const threadStatus = () => thread().getByRole('status', { name: 'Request status' });
const studioCall = (fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as unknown as { studio: Record<string, (...x: unknown[]) => unknown> }).studio[f as string](...(a as unknown[])), [fn, args] as const);

/** Starts a thread with the test agent from the viewer, about `layer` over [from, to). */
async function send(prompt: string, options: { full?: boolean; layer?: string; from?: number; to?: number } = {}): Promise<void> {
  if (await thread().count()) await thread().getByRole('button', { name: 'New thread' }).click();
  await studioCall('select', options.layer ?? 'ball');
  await studioCall('setRange', options.from ?? 12, options.to ?? 24);
  await panel().getByRole('combobox', { name: 'Agent' }).selectOption('fake');
  const full = panel().getByRole('checkbox', { name: 'Full access' });
  if ((await full.isChecked()) !== (options.full ?? false)) await full.click();
  await panel().getByRole('textbox', { name: 'Prompt' }).fill(prompt);
  await panel().getByRole('button', { name: 'Send to agent' }).click();
  await thread().waitFor();
}

describe('an agent in the studio', () => {
  it('offers the external agent and the test agent, ready', async () => {
    // Claude's and Codex's CLIs are asked for their status too, which can take a few seconds.
    await expect
      .poll(async () => (await panel().getByRole('combobox', { name: 'Agent' }).locator('option').allTextContents()).join(' | '), { timeout: 30000 })
      .toContain('Test agent');
    const { agents } = (await (await fetch(`${vite.base}__studio/agents`, { headers: vite.auth })).json()) as { agents: { id: string; ready: boolean }[] };
    // Claude and Codex are offered too; whether they are ready depends on this machine's CLIs.
    expect(agents.map((a) => a.id)).toEqual(['external', 'claude', 'codex', 'fake']);
    expect(agents.filter((a) => a.id === 'external' || a.id === 'fake').every((a) => a.ready)).toBe(true);
  });

  it('works a thread: streams text, steps and rendered frames, edits only the range, resumes on a reply, reverts, settles', async () => {
    await send('make the ball blue');
    await expectText(turn(1), 'Made the ball blue over frames 12 to 24.');
    await expectText(turn(1), 'Studio: apply_to_selection');
    await turn(1).getByRole('img', { name: 'Frame 12' }).waitFor();
    await expectText(threadStatus(), 'your turn');
    const scene = JSON.parse(readFileSync(sceneFile(A), 'utf8'));
    expect(scene.layers[0].overrides).toEqual([{ from: 12, to: 24, params: { fill: '#3355ff' } }]);
    // The thumbnail is the frame the agent rendered, served next to the thread.
    const src = await turn(1).getByRole('img', { name: 'Frame 12' }).getAttribute('src');
    const png = await (await fetch(new URL(src!, vite.base), { headers: vite.auth })).arrayBuffer();
    expect(new Uint8Array(png).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));

    await thread().getByRole('textbox', { name: 'Reply' }).fill('a bit darker');
    await thread().getByRole('button', { name: 'Reply' }).click();
    await expectText(turn(2), 'Darker now.');
    await expectText(turn(2), 'Fake agent resumed fake-');
    const [t] = await queue.list();
    expect(t.turns.map((x) => x.status)).toEqual(['done', 'done']);
    expect(t.turns[1].usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    await turn(1).getByRole('button', { name: 'Revert to before turn 1' }).click();
    await expectText(turn(2), 'reverted');
    expect(readFileSync(sceneFile(A), 'utf8')).toBe(originals.get(A));
    await thread().getByRole('button', { name: 'Settle' }).click();
    await expectText(threadStatus(), 'settled');
  });

  it('asks before writing outside scenes/, src/rigs/ and src/audio/ and before commands, and full access does not', async () => {
    await send('write a rig and run the tests');
    const card = () => thread().getByRole('group', { name: /^Approval: / });
    await expectText(card(), `Edit docs/test-tmp-fake-${process.pid}.md`);
    expect(existsSync(RIG_FILE)).toBe(true); // inside src/rigs, no card
    await card().getByRole('button', { name: 'Decline' }).click();
    await expectText(card().last(), 'Run a command');
    await expectText(card().last(), 'npm test');
    await card().last().getByRole('button', { name: 'Allow' }).click();
    await expectText(turn(1), 'Wrote the rig.');
    expect(existsSync(DOC_FILE)).toBe(false);
    await expectText(turn(1), 'Declined');
    rmSync(RIG_FILE, { force: true });

    await send('write a rig and run the tests', { full: true });
    await expectText(turn(1), 'Wrote the rig.');
    expect(await card().count()).toBe(0);
    expect(existsSync(DOC_FILE)).toBe(true);
    rmSync(DOC_FILE, { force: true });
    rmSync(RIG_FILE, { force: true });
  });

  it('asks questions on a card: one pick moves on, several picks and a typed answer send, keys pick, Skip lets the agent decide', async () => {
    const card = () => panel().getByRole('region', { name: 'Questions from the agent' });
    await send('ask about the title');
    await expectText(card(), 'Which typeface for the title?');
    await expectText(card(), '1 of 2');
    // The preview shows for the option with focus.
    await card().getByRole('radio', { name: /Fraunces/ }).focus();
    await expectText(card(), 'Aa Bb Cc');
    await card().getByRole('radio', { name: /Fraunces/ }).click();
    await expectText(card(), 'What else goes with it?');
    await card().getByRole('checkbox', { name: /A kicker/ }).click();
    await card().getByRole('checkbox', { name: /A date/ }).click();
    await card().getByRole('textbox').fill('A logo');
    await card().getByRole('button', { name: 'Send' }).click();
    await expectText(turn(1), 'You chose: Font Fraunces (Recommended); Extras A kicker + A date + A logo.');
    await expectText(turn(1), 'Set the title.');
    expect(await card().count()).toBe(0);
    // The thread keeps what was asked and answered.
    await expectText(turn(1).getByRole('group', { name: 'Questions' }), 'A kicker, A date, A logo');

    await send('ask one thing');
    await card().getByRole('radio', { name: /Red/ }).focus();
    await page.keyboard.press('2');
    await expectText(turn(1), 'You chose: Colour Blue.');

    await send('ask one thing');
    await card().getByRole('button', { name: 'Skip' }).click();
    await expectText(turn(1), 'No answer, so I picked for you.');
    await expectText(turn(1), 'Skipped: the agent decides');

    // Answers that don't fit the card are refused; Stop ends the wait.
    // A card that opens while its thread isn't showing gets a toast, and Answer brings it up.
    await send('ask and wait');
    await thread().getByRole('button', { name: 'New thread' }).click();
    const toast = page.getByRole('status', { name: 'Agent waits for you' });
    await expectText(toast, 'needs you: Which colour?');
    await toast.getByRole('button', { name: 'Answer' }).click();
    await card().waitFor();
    const [t] = (await queue.list()).filter((r) => r.status === 'working');
    // The turn's log reaches the disk shortly after the viewer hears of it.
    const askedEvent = async () => (await readTurnEvents(join(queue.threadDir(t.id), 'turn-0.jsonl'))).find((e) => e.type === 'questions');
    await expect.poll(askedEvent).toBeDefined();
    const asked = (await askedEvent()) as { id: string };
    const post = (answers: unknown) =>
      fetch(`${vite.base}__studio/requests/${t.id}/questions/${asked.id}`, { method: 'POST', headers: { ...vite.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
    expect((await post({ colour: ['Red', 'Blue'] })).status).toBe(400);
    expect((await post({ shade: ['Red'] })).status).toBe(400);
    await thread().getByRole('button', { name: 'Stop' }).click();
    await expectText(threadStatus(), 'your turn');
    expect(await card().count()).toBe(0);
    expect((await post({ colour: ['Red'] })).status).toBe(409);
  });

  it('works one thread per scene at a time, and threads on other scenes in parallel', async () => {
    const selection = (sceneId: string) => ({ sceneId, layerId: 'ball', from: 0, to: 12 });
    const one = await queue.create({ selection: selection(A), frame: 0, prompt: 'slow one', references: [], agent: 'fake', settings: { access: 'studio' } });
    const two = await queue.create({ selection: selection(A), frame: 0, prompt: 'slow two', references: [], agent: 'fake', settings: { access: 'studio' } });
    const three = await queue.create({ selection: selection(B), frame: 0, prompt: 'slow three', references: [], agent: 'fake', settings: { access: 'studio' } });
    const status = async () => Object.fromEntries((await queue.list()).map((r) => [r.id, r.status]));
    await expect.poll(async () => [(await status())[one.id], (await status())[three.id]], { timeout: 10000 }).toEqual(['working', 'working']);
    expect((await status())[two.id]).toBe('pending');
    await expect.poll(async () => (await status())[two.id], { timeout: 10000 }).toBe('working');
    await expect.poll(async () => (await status())[two.id], { timeout: 10000 }).toBe('your_turn');
    expect((await status())[one.id]).toBe('your_turn');
    expect((await status())[three.id]).toBe('your_turn');
  });

  it('stops a turn, keeping its edits, and hands the thread back', async () => {
    await send('slow edit');
    await expectText(turn(1), 'Orange so far.');
    await thread().getByRole('button', { name: 'Stop' }).click();
    await expectText(turn(1), 'stopped');
    await expectText(threadStatus(), 'your turn');
    expect(JSON.parse(readFileSync(sceneFile(A), 'utf8')).layers[0].overrides).toContainEqual({ from: 12, to: 24, params: { fill: '#ff8800' } });
    await turn(1).getByRole('button', { name: 'Revert to before turn 1' }).click();
    await expectText(turn(1), 'reverted');
  });

  it('marks a turn interrupted when the studio server stops, and resumes the session on the next reply', async () => {
    const t = await queue.create({ selection: { sceneId: B, layerId: 'ball', from: 0, to: 12 }, frame: 0, prompt: 'long wait', references: [], agent: 'fake', settings: { access: 'studio' } });
    await expect.poll(async () => (await queue.get(t.id)).status, { timeout: 10000 }).toBe('working');
    await vite.close();
    await expect.poll(async () => (await queue.get(t.id)).turns[0].status, { timeout: 10000 }).toBe('interrupted');
    await startServer();
    await openViewer();
    await queue.reply(t.id, { selection: { sceneId: B, layerId: 'ball', from: 0, to: 12 }, frame: 0, prompt: 'slow reply', references: [] });
    await expect.poll(async () => (await queue.get(t.id)).status, { timeout: 15000 }).toBe('your_turn');
    const events = await readTurnEvents(join(queue.threadDir(t.id), 'turn-1.jsonl'));
    expect(events.some((e) => e.type === 'status' && e.message.startsWith(`Fake agent resumed fake-${t.id}`))).toBe(true);
    const first = await readTurnEvents(join(queue.threadDir(t.id), 'turn-0.jsonl'));
    expect(first.some((e) => e.type === 'status' && e.message === 'The studio server stopped during this turn.')).toBe(true);
    await queue.revertTo(t.id, 0);
  });
});

describe('agents in a project (ADR 0007)', () => {
  const read = (name: string) => readFileSync(join(PROJECT_DIR, name), 'utf8');
  const start = (sceneId: string, prompt: string) =>
    queue.create({ selection: { sceneId: `${P}/${sceneId}`, from: 0, to: 12 }, frame: 0, prompt, references: [], agent: 'fake', settings: { access: 'studio' } });
  const status = async (id: number) => (await queue.get(id)).status;

  it('works threads on two shots at once, lets the film thread recut, holds a cast edit until the shots are done, and reverts both files', async () => {
    const film = read('film.json');
    const cast = read('project.json');
    const hold = await start('meet', 'project hold');
    const quick = await start('pip', 'project quick');
    await expect.poll(() => status(hold.id), { timeout: 10000 }).toBe('working');
    // pip's thread runs and finishes while meet's still works.
    await expect.poll(() => status(quick.id), { timeout: 10000 }).toBe('your_turn');
    expect(await status(hold.id)).toBe('working');

    const cut = await start('film', 'project recut');
    await expect.poll(() => status(cut.id), { timeout: 10000 }).toBe('your_turn');
    const recut = JSON.parse(read('film.json')) as { layers: { id: string; start?: number; out?: number }[] };
    expect(recut.layers.find((l) => l.id === 'pip')?.start).toBe(3.5);

    // The cast edit waits for meet's thread, which is still working.
    await queue.reply(cut.id, { selection: { sceneId: `${P}/film`, from: 0, to: 12 }, frame: 0, prompt: 'project recast', references: [] });
    await expect.poll(async () => (await readTurnEvents(join(queue.threadDir(cut.id), 'turn-1.jsonl'))).some((e) => e.type === 'status' && /waits until no other request there is working/.test(e.message)), { timeout: 10000 }).toBe(true);
    expect(read('project.json')).toBe(cast);
    expect(await status(hold.id)).toBe('working');
    await expect.poll(() => status(hold.id), { timeout: 15000 }).toBe('your_turn');
    await expect.poll(() => status(cut.id), { timeout: 15000 }).toBe('your_turn');
    expect(JSON.parse(read('project.json')).cast.bruno.params.body).toBe('#d8b48a');
    const done = await queue.get(cut.id);
    expect(done.turns.map((t) => [t.status, t.projectChanged ?? false])).toEqual([['done', false], ['done', true]]);
    expect((await queue.get(hold.id)).turns[0].projectChanged).toBeUndefined();

    // Revert to before the recast: project.json and the film go back together; the recut stays.
    await queue.revertTo(cut.id, 1);
    expect(read('project.json')).toBe(cast);
    expect(JSON.parse(read('film.json'))).toEqual(recut);
    await queue.revertTo(cut.id, 0);
    expect(read('film.json')).toBe(film);
    for (const id of [hold.id, quick.id]) await queue.revertTo(id, 0);
  });
});
