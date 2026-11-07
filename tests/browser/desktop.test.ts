/**
 * M10: the app (ADR 0008), run from the repo's sources in Electron and
 * driven by Playwright, with its home folder and settings in a temporary
 * folder so yours stay untouched. It starts the way Finder starts it, with
 * launchd's short PATH.
 *
 * - The welcome screen opens the sample project, and the viewer opens on it,
 *   paired with the studio server through the preload bridge.
 * - The server refuses requests without the pairing, and tells tools where
 *   it is, so a tool on the folder reuses it.
 * - The server finds `claude` through the login shell's PATH. HOME stays
 *   yours for that, since the shell reads its profile there; new folders go
 *   to FRAME_STUDIO_HOME instead.
 * - A test agent turn writes a rig into the folder's rigs/ and uses it.
 * - Projects in the sidebar (ADR 0013): New project makes a folder, a row of
 *   another project opens it on that scene in one load, what the viewer keeps
 *   comes along, and an agent at work in one project keeps working while
 *   another is on screen, its server stopping once it's done.
 * - The next launch reopens the last project.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStudio } from '../../tools/render/studio';
import { connectStudio } from '../../tools/studio/connect';
import { electronBinary } from '../../tools/studio/electron-worker';
import { REPO, studioFolder } from '../../tools/studio/folder';
import { StudioQueue } from '../../tools/studio/queue';

const home = mkdtempSync(join(tmpdir(), 'frame-studio-home-'));
const projects = join(home, 'Frame Studio Projects');
const folder = join(projects, 'Sample');
let app: ElectronApplication | null = null;

function launch(): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  return _electron.launch({
    executablePath: electronBinary(),
    args: [join(REPO, 'desktop/main.ts')],
    env: { ...env, FRAME_STUDIO_HOME: home, FRAME_STUDIO_USER_DATA: join(home, 'userdata'), FRAME_STUDIO_FAKE_AGENT: '1', FRAME_STUDIO_WARM_MS: '0', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
}

/** The viewer window, once its page has booted. */
async function viewerWindow(electron: ElectronApplication): Promise<Page> {
  const isViewer = (p: Page) => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(p.url());
  const page = electron.windows().find(isViewer) ?? (await electron.waitForEvent('window', { predicate: isViewer, timeout: 60_000 }));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined, undefined, { timeout: 60_000 });
  return page;
}

const discovery = () => JSON.parse(readFileSync(join(folder, '.frame-studio/server.json'), 'utf8')) as { url: string; token: string };

/** Sends a turn the way the viewer does: only a turn through the server's route runs by itself (ADR 0017). */
async function sendTurn(prompt: string): Promise<{ id: number }> {
  const { url, token } = discovery();
  const res = await fetch(`${url}/__studio/requests`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection: { sceneId: 'hello', from: 0, to: 72 }, frame: 0, prompt, references: [], agent: 'fake', settings: { access: 'studio' } }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { request: { id: number } }).request;
}

beforeAll(() => {
  // The app opens the viewer the build made, as the packaged app does.
  execFileSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: REPO, stdio: 'ignore' });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

describe('the app', () => {
  it('opens the sample project from the welcome screen, and the viewer on it', async () => {
    app = await launch();
    const welcome = await app.firstWindow();
    await welcome.getByRole('button', { name: 'Open the sample project' }).click();
    const viewer = await viewerWindow(app);
    const state = await viewer.evaluate(() => {
      const w = window as unknown as { studio: { scenes: string[]; errors: string[] }; frameStudioDesktop?: object };
      return { scenes: w.studio.scenes, errors: w.studio.errors, bridge: Object.keys(w.frameStudioDesktop ?? {}).sort(), node: typeof (window as unknown as { require?: unknown }).require };
    });
    // The sample is Bears' story as a project folder (ADR 0013): its scenes, then the film, a composition.
    expect(state.scenes).toEqual(['film-background', 'hello', 'meet', 'pip', 'together', 'film']);
    expect(state.errors).toEqual([]);
    // Only the bridge reaches the page: no Node, no Electron.
    expect(state.bridge).toEqual(['boot', 'convertFilm', 'forgetProject', 'newProject', 'onOpenSettings', 'openFolder', 'openProject', 'poster', 'projects', 'reveal', 'setDraft', 'setPref', 'token', 'trust', 'voice']);
    expect(state.node).toBe('undefined');
    const tsconfig = JSON.parse(readFileSync(join(folder, 'tsconfig.json'), 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(tsconfig.compilerOptions.paths['@frame-studio/*']).toEqual([`${join(REPO, 'src')}/*`]);
  });

  it('refuses requests without the pairing, and tells tools where it is', async () => {
    const { url, token } = discovery();
    expect(statSync(join(folder, '.frame-studio/server.json')).mode & 0o077).toBe(0);
    expect((await fetch(`${url}/__studio/files`)).status).toBe(401);
    expect((await fetch(`${url}/__studio/files`, { headers: { Authorization: 'Bearer not-the-token-at-all' } })).status).toBe(401);
    expect((await fetch(`${url}/__studio/files`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    // A tool on the folder reuses the app's server and its render worker.
    const connected = await connectStudio(studioFolder(folder));
    try {
      expect(connected.server).toBeNull();
      expect(connected.url).toBe(url);
      const studio = await openStudio('film', { transport: connected.transport });
      expect(await studio.call('pixelHash', 50)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await connected.close();
    }
  });

  it('finds claude through the login shell, though Finder gives a short PATH', async () => {
    let installed = false;
    try {
      execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v claude'], { stdio: 'ignore', timeout: 10_000 });
      installed = true;
    } catch {
      // No claude on this machine: nothing to find.
    }
    const { url, token } = discovery();
    const { agents } = (await (await fetch(`${url}/__studio/agents?fresh`, { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      agents: { id: string; ready: boolean; detail: string }[];
    };
    const claude = agents.find((a) => a.id === 'claude')!;
    if (installed) expect(claude.detail).not.toMatch(/not installed|not found/i);
    expect(agents.find((a) => a.id === 'fake')?.ready).toBe(true);
  });

  it("lets an agent write a rig into the folder's rigs/ and use it", async () => {
    const hello = JSON.parse(readFileSync(join(folder, 'scenes/hello.json'), 'utf8')) as { layers: unknown[] };
    const rig = `import type { Rig } from '@frame-studio/engine/types';
import { col, num, readParams } from '@frame-studio/rigs/parts/params';

const params = { r: num(40, 1, 400, 'Radius.'), fill: col('#ffd166', 'Fill.') };

export const twinkle: Rig = {
  id: 'twinkle',
  description: 'A small yellow dot.',
  params,
  draw(ctx, values) {
    const p = readParams(params, values);
    ctx.fillStyle = p.string('fill');
    ctx.beginPath();
    ctx.arc(1000, 150, p.number('r'), 0, Math.PI * 2);
    ctx.fill();
  },
};
`;
    mkdirSync(join(folder, '.frame-studio'), { recursive: true });
    writeFileSync(
      join(folder, '.frame-studio/fake-agent.json'),
      JSON.stringify({
        scripts: [
          {
            match: 'add a twinkle',
            steps: [
              { write: { path: 'rigs/twinkle.ts', content: rig } },
              { wait: 1000 },
              { tool: 'update_scene', args: { id: 'hello', patch: { layers: [...hello.layers, { id: 'twinkle', rig: 'twinkle' }] } } },
              { say: 'Added a twinkle.' },
            ],
          },
        ],
      }),
    );
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const request = await sendTurn('add a twinkle');
    await expect.poll(async () => (await queue.get(request.id)).status, { timeout: 60_000 }).toBe('your_turn');
    expect((await queue.get(request.id)).turns[0].status).toBe('done');
    const layers = (JSON.parse(readFileSync(join(folder, 'scenes/hello.json'), 'utf8')) as { layers: { id: string; rig?: string }[] }).layers;
    expect(layers.at(-1)).toEqual({ id: 'twinkle', rig: 'twinkle' });
    const viewer = await viewerWindow(app!);
    await viewer.evaluate(() => (window as unknown as { studio: { selectScene(id: string): void } }).studio.selectScene('hello'));
    await expect
      .poll(() => viewer.evaluate(() => (window as unknown as { studio: { scene: { layers: { id: string }[] } | null; errors: string[] } }).studio.scene?.layers.map((l) => l.id)), { timeout: 15_000 })
      .toContain('twinkle');
  });

  it('lists projects in the sidebar, and an agent keeps working in the project left behind', async () => {
    const film = join(projects, 'My Film');
    // The save panel, answered as if the user named the project "My Film".
    await app!.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    }, film);
    writeFileSync(join(folder, '.frame-studio/fake-agent.json'), JSON.stringify({ scripts: [{ match: 'take your time', steps: [{ say: 'Starting. ' }, { wait: 8000 }, { say: 'Finished.' }] }] }));
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const slow = await sendTurn('take your time');
    await expect.poll(async () => (await queue.get(slow.id)).status, { timeout: 30_000 }).toBe('working');
    const sample = discovery();
    const alive = () => fetch(`${sample.url}/__studio/files`, { headers: { Authorization: `Bearer ${sample.token}` } }).then((r) => r.ok, () => false);

    const viewer = await viewerWindow(app!);
    const nav = viewer.getByRole('navigation', { name: 'Studio' });
    const group = (name: string) => nav.getByRole('region', { name });
    await nav.getByRole('button', { name: 'New', exact: true }).click();
    await viewer.getByRole('menuitem', { name: 'New project…' }).click();
    await expect.poll(() => viewer.url(), { timeout: 30_000 }).not.toContain(new URL(sample.url).host);
    await viewer.waitForFunction(() => (window as unknown as { studio?: { scenes: string[] } }).studio?.scenes !== undefined, undefined, { timeout: 30_000 });
    expect(await viewer.evaluate(() => (window as unknown as { studio: { scenes: string[] } }).studio.scenes)).toEqual([]);
    for (const sub of ['scenes', 'compositions', 'rigs', 'audio', 'media']) expect(statSync(join(film, sub)).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(join(film, 'project.json'), 'utf8'))).toEqual({ name: 'My Film', fps: 24, size: [1920, 1080], cast: {} });
    // The project on screen sits first and open, the other below it, folded.
    await expect.poll(() => nav.locator('.project-row .name').allTextContents(), { timeout: 10_000 }).toEqual(['My Film', 'Sample']);
    expect(await group('My Film').locator('.project-row').getAttribute('aria-expanded')).toBe('true');
    expect(await group('Sample').locator('.project-row').getAttribute('aria-expanded')).toBe('false');

    // Sample's agent is still at it, and its header says so.
    expect(await alive()).toBe(true);
    const sampleStatus = () => group('Sample').locator('.project-head .status-dot').getAttribute('title', { timeout: 10_000 });
    await expect.poll(sampleStatus, { timeout: 10_000 }).toContain('1 working');
    await expect.poll(async () => (await queue.get(slow.id)).status, { timeout: 30_000 }).toBe('your_turn');
    expect((await queue.get(slow.id)).turns[0].summary).toBe('Finished.');
    // Done, Sample's server stops, and its header shows the finished thread as your turn.
    await expect.poll(alive, { timeout: 20_000 }).toBe(false);
    await expect.poll(sampleStatus, { timeout: 10_000 }).not.toContain('working');
    expect(await group('Sample').locator('.project-head .status-dot.is-your_turn').count()).toBe(1);
    // Its videos and scenes are still listed, from disk, with no server there.
    await group('Sample').locator('.project-row').click();
    await group('Sample').getByRole('button', { name: 'hello', exact: true }).waitFor();
  });

  it('opens a project on the scene you click in the sidebar, in one load, with what the viewer keeps', async () => {
    const viewer = await viewerWindow(app!);
    const nav = viewer.getByRole('navigation', { name: 'Studio' });
    const group = (name: string) => nav.getByRole('region', { name });
    const prompt = viewer.getByRole('complementary', { name: 'Agent' }).getByRole('textbox', { name: 'Prompt' });
    // Each project's page has an origin of its own, so this only survives through the app.
    await prompt.fill('a thought for later');
    const loads: string[] = [];
    viewer.on('load', () => loads.push(viewer.url()));

    await group('Sample').getByRole('button', { name: 'hello', exact: true }).click();
    await expect.poll(() => viewer.url(), { timeout: 30_000 }).toContain('scene=hello');
    await viewer.waitForFunction(() => (window as unknown as { studio?: { scene?: { id: string } | null } }).studio?.scene?.id === 'hello', undefined, { timeout: 30_000 });
    expect(loads).toHaveLength(1);
    await expect.poll(() => nav.locator('.project-row .name').first().textContent(), { timeout: 10_000 }).toBe('Sample');
    expect(await group('Sample').getByRole('button', { name: 'hello', exact: true }).getAttribute('aria-current')).toBe('page');
    await expect.poll(() => group('My Film').locator('.project-row').getAttribute('aria-expanded')).toBe('false');

    // Back again: the draft waited, and the folds are the app's, not the page's.
    await group('My Film').locator('.project-row').click();
    await group('My Film').getByRole('button', { name: 'Open' }).click();
    await expect.poll(() => nav.locator('.project-row .name').first().textContent(), { timeout: 30_000 }).toBe('My Film');
    await expect.poll(() => prompt.inputValue(), { timeout: 10_000 }).toBe('a thought for later');
    await prompt.fill('');
    await expect.poll(() => (JSON.parse(readFileSync(join(home, 'userdata/settings.json'), 'utf8')) as { prefs: Record<string, string> }).prefs['frame-studio:sidebar'], { timeout: 10_000 }).toContain('My Film');
  });

  it("shows a question card waiting in a project left behind as input, and the card is there on switching back", async () => {
    writeFileSync(
      join(folder, '.frame-studio/fake-agent.json'),
      JSON.stringify({ scripts: [{ match: 'ask me', steps: [{ ask: [{ id: 'c', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, { say: 'Done.' }] }] }),
    );
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const viewer = await viewerWindow(app!);
    const nav = viewer.getByRole('navigation', { name: 'Studio' });
    const group = (name: string) => nav.getByRole('region', { name });
    const onScreen = (name: string) => expect.poll(() => nav.locator('.project-row .name').first().textContent(), { timeout: 30_000 }).toBe(name);
    // A group you opened by hand stays open, so only a folded one needs the click.
    const unfold = async (name: string) => {
      const row = group(name).locator('.project-row');
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
    };
    // My Film is on screen and Sample's server has stopped. Open Sample, ask, and leave while the card waits.
    await unfold('Sample');
    await group('Sample').getByRole('button', { name: 'hello', exact: true }).click();
    await onScreen('Sample');
    const asking = await sendTurn('ask me');
    await expect.poll(async () => (await queue.get(asking.id)).turns[0].waitingSince !== undefined, { timeout: 30_000 }).toBe(true);

    await unfold('My Film');
    await group('My Film').getByRole('button', { name: 'Open' }).click();
    await onScreen('My Film');
    await expect.poll(() => group('Sample').locator('.project-head .status-dot.is-input').count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => group('Sample').locator('.project-head .status-dot.is-input').getAttribute('title'), { timeout: 10_000 }).toContain('waiting on your input');
    await unfold('Sample');
    await group('Sample').getByRole('button', { name: 'hello', exact: true }).click();
    await onScreen('Sample');
    await viewer.waitForFunction(() => (window as unknown as { studio?: { scenes: string[] } }).studio?.scenes !== undefined, undefined, { timeout: 30_000 });
    // The thread waits where it was; open it and answer.
    await nav.getByRole('button', { name: /^Threads/ }).click();
    await nav.getByRole('article', { name: `Request ${asking.id}` }).getByRole('button').click();
    const card = viewer.getByRole('region', { name: 'Questions from the agent' });
    await card.getByRole('radio', { name: /Blue/ }).click();
    await expect.poll(async () => (await queue.get(asking.id)).status, { timeout: 30_000 }).toBe('your_turn');
  });

  it('opens a thread of another project from its card, with that scene and the conversation, in one load', async () => {
    const viewer = await viewerWindow(app!);
    const nav = viewer.getByRole('navigation', { name: 'Studio' });
    const group = (name: string) => nav.getByRole('region', { name, exact: true });
    const panel = viewer.getByRole('complementary', { name: 'Agent' });
    const scene = () => viewer.evaluate(() => (window as unknown as { studio?: { selection: { sceneId: string } | null } }).studio?.selection?.sceneId);
    const row = (name: string) => group(name).locator('.project-row');
    const unfold = async (name: string) => {
      if ((await row(name).getAttribute('aria-expanded')) === 'false') await row(name).click();
    };

    // Written straight into My Film's folder, with no agent and no server there once we've left it.
    const film = join(projects, 'My Film');
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const finished = (await queue.list()).find((t) => t.status === 'your_turn')!;
    const at = '2026-11-06T10:00:00.000Z';
    const ask = (prompt: string, sceneId: string) => ({ prompt, references: [], selection: { sceneId, from: 0, to: 24 }, frame: 0, at });
    mkdirSync(join(film, '.frame-studio', 'requests'), { recursive: true });
    writeFileSync(join(film, 'scenes', 'lake.json'), JSON.stringify({ id: 'lake', fps: 24, duration: 2, size: [1920, 1080], seed: 1, background: { rig: 'paper', params: {} }, layers: [] }));
    writeFileSync(
      join(film, '.frame-studio', 'requests', '0001.json'),
      JSON.stringify({ id: 1, createdAt: at, status: 'your_turn', agent: 'claude', sceneId: 'lake', turns: [{ ask: ask('make the lake bluer', 'lake'), status: 'done', settings: { access: 'studio', model: 'test-model-1' }, completedAt: at, summary: 'Bluer.' }] }),
    );
    writeFileSync(
      join(film, '.frame-studio', 'requests', '0002.json'),
      JSON.stringify({ id: 2, createdAt: at, status: 'settled', agent: 'fake', sceneId: 'lake', settledAt: at, turns: [{ ask: ask('an old idea', 'lake'), status: 'done', completedAt: at }] }),
    );

    // On Sample, its own thread sits open, and My Film's show from disk with no server started.
    await nav.getByRole('button', { name: /^Threads/ }).click();
    expect(await nav.getByRole('button', { name: 'Library' }).count()).toBe(0);
    await unfold('My Film');
    const card = group('My Film').getByRole('article', { name: 'Request 1' });
    await expect.poll(() => card.textContent(), { timeout: 10_000 }).toContain('make the lake bluer');
    expect(await card.textContent()).toContain('test-model-1');
    expect(await card.textContent()).toContain('Your turn');
    expect(await group('My Film').getByRole('article', { name: 'Request 2' }).count()).toBe(0);
    await group('My Film').getByRole('button', { name: 'Done' }).first().click();
    await group('My Film').getByRole('article', { name: 'Request 2' }).waitFor();
    expect(await group('Sample').getByRole('article', { name: `Request ${finished.id}` }).count()).toBe(1);

    // Filtering searches titles, across projects.
    await viewer.keyboard.press('ControlOrMeta+f');
    await nav.getByRole('searchbox', { name: 'Filter threads' }).fill('BLUER');
    await expect.poll(() => nav.getByRole('article').count()).toBe(1);
    await viewer.keyboard.press('Escape');
    await expect.poll(() => nav.getByRole('article').count()).toBeGreaterThan(1);

    // One click: the project, its scene and the conversation.
    let loads = 0;
    viewer.on('load', () => loads++);
    await card.getByRole('button').click();
    await expect.poll(scene, { timeout: 60_000 }).toBe('lake');
    await panel.getByRole('region', { name: 'Request 1' }).waitFor({ timeout: 30_000 });
    expect(await panel.getByRole('heading', { name: 'make the lake bluer' }).count()).toBe(1);
    expect(loads).toBe(1);
    // The view you were in came along, and the card it opened has the ring.
    expect(await nav.getByRole('button', { name: /^Threads/ }).getAttribute('aria-pressed')).toBe('true');
    expect(await group('My Film').getByRole('article', { name: 'Request 1' }).getByRole('button').getAttribute('aria-current')).toBe('true');
    expect(new URL(viewer.url()).searchParams.has('thread')).toBe(false);

    // Move on and the turn you read reads Done. Command-1 and 2 switch views, and Footage's scene row shows nothing for it.
    await panel.getByRole('button', { name: 'New thread' }).click();
    await expect.poll(() => group('My Film').getByRole('article', { name: 'Request 1' }).textContent()).toContain('Done');
    await viewer.keyboard.press('ControlOrMeta+1');
    await nav.getByRole('button', { name: 'Library' }).waitFor();
    expect(await group('My Film').getByRole('button', { name: 'lake', exact: true }).locator('.status-dot').count()).toBe(0);
    await viewer.keyboard.press('ControlOrMeta+2');
    await unfold('Sample');
    await group('Sample').getByRole('article', { name: `Request ${finished.id}` }).getByRole('button').click();
    await expect.poll(scene, { timeout: 60_000 }).toBe('hello');
    await panel.getByRole('region', { name: `Request ${finished.id}` }).waitFor({ timeout: 30_000 });
  });

  it('reopens the last project on the next launch', async () => {
    await app!.close();
    app = await launch();
    const viewer = await viewerWindow(app);
    expect(await viewer.evaluate(() => (window as unknown as { studio: { scenes: string[] } }).studio.scenes)).toContain('film');
    expect(app.windows().some((w) => w.url().endsWith('welcome.html'))).toBe(false);
  });
});
