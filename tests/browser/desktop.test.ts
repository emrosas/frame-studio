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
 * - Projects on screen (ADR 0013): New project makes a folder, the switcher
 *   switches, and an agent at work in one project keeps working while another
 *   is on screen, its server stopping once it's done.
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
    env: { ...env, FRAME_STUDIO_HOME: home, FRAME_STUDIO_USER_DATA: join(home, 'userdata'), FRAME_STUDIO_FAKE_AGENT: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
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
    expect(state.scenes).toEqual(['hello', 'bears-story/film', 'bears-story/meet', 'bears-story/pip', 'bears-story/together']);
    expect(state.errors).toEqual([]);
    // Only the bridge reaches the page: no Node, no Electron.
    expect(state.bridge).toEqual(['newProject', 'openFolder', 'openProject', 'projects', 'reveal', 'token']);
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
      const studio = await openStudio('bears-story/film', { transport: connected.transport });
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
    const request = await queue.create({ selection: { sceneId: 'hello', from: 0, to: 72 }, frame: 0, prompt: 'add a twinkle', references: [], agent: 'fake', settings: { access: 'studio' } });
    await expect.poll(async () => (await queue.get(request.id)).status, { timeout: 60_000 }).toBe('your_turn');
    expect((await queue.get(request.id)).turns[0].status).toBe('done');
    const layers = (JSON.parse(readFileSync(join(folder, 'scenes/hello.json'), 'utf8')) as { layers: { id: string; rig?: string }[] }).layers;
    expect(layers.at(-1)).toEqual({ id: 'twinkle', rig: 'twinkle' });
    const viewer = await viewerWindow(app!);
    await expect
      .poll(() => viewer.evaluate(() => (window as unknown as { studio: { scene: { layers: { id: string }[] } | null; errors: string[] } }).studio.scene?.layers.map((l) => l.id)), { timeout: 15_000 })
      .toContain('twinkle');
  });

  it('switches projects from the top left, and an agent keeps working in the project left behind', async () => {
    const film = join(projects, 'My Film');
    // The save panel, answered as if the user named the project "My Film".
    await app!.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog;
    }, film);
    writeFileSync(join(folder, '.frame-studio/fake-agent.json'), JSON.stringify({ scripts: [{ match: 'take your time', steps: [{ say: 'Starting. ' }, { wait: 8000 }, { say: 'Finished.' }] }] }));
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const slow = await queue.create({ selection: { sceneId: 'hello', from: 0, to: 72 }, frame: 0, prompt: 'take your time', references: [], agent: 'fake', settings: { access: 'studio' } });
    await expect.poll(async () => (await queue.get(slow.id)).status, { timeout: 30_000 }).toBe('working');
    const sample = discovery();
    const alive = () => fetch(`${sample.url}/__studio/files`, { headers: { Authorization: `Bearer ${sample.token}` } }).then((r) => r.ok, () => false);

    const viewer = await viewerWindow(app!);
    const switcher = viewer.locator('.switcher-btn');
    await switcher.click();
    await viewer.getByRole('menuitem', { name: 'New project…' }).click();
    await expect.poll(() => viewer.url(), { timeout: 30_000 }).not.toContain(new URL(sample.url).host);
    await viewer.waitForFunction(() => (window as unknown as { studio?: { scenes: string[] } }).studio?.scenes !== undefined, undefined, { timeout: 30_000 });
    expect(await viewer.evaluate(() => (window as unknown as { studio: { scenes: string[] } }).studio.scenes)).toEqual([]);
    for (const sub of ['scenes', 'rigs', 'audio', 'media']) expect(statSync(join(film, sub)).isDirectory()).toBe(true);
    await expect.poll(() => switcher.textContent()).toContain('My Film');

    // Sample's agent is still at it, and the switcher says so.
    expect(await alive()).toBe(true);
    await switcher.click();
    const sampleItem = viewer.getByRole('menuitem', { name: /Sample/ });
    await expect.poll(async () => (await sampleItem.locator('[title$="working"]').count()) > 0, { timeout: 10_000 }).toBe(true);
    await viewer.keyboard.press('Escape');
    await expect.poll(async () => (await queue.get(slow.id)).status, { timeout: 30_000 }).toBe('your_turn');
    expect((await queue.get(slow.id)).turns[0].summary).toBe('Finished.');
    // Done, Sample's server stops, and the switcher shows the finished thread as your turn.
    await expect.poll(alive, { timeout: 20_000 }).toBe(false);
    await switcher.click();
    await expect.poll(async () => (await sampleItem.locator('[title$="your turn"]').count()) > 0, { timeout: 10_000 }).toBe(true);

    await sampleItem.click();
    await expect.poll(() => viewer.evaluate(() => (window as unknown as { studio?: { scenes: string[] } }).studio?.scenes ?? []), { timeout: 30_000 }).toContain('bears-story/film');
    await expect.poll(() => switcher.textContent()).toContain('Sample');
  });

  it("shows a question card waiting in a project left behind as input, and the card is there on switching back", async () => {
    writeFileSync(
      join(folder, '.frame-studio/fake-agent.json'),
      JSON.stringify({ scripts: [{ match: 'ask me', steps: [{ ask: [{ id: 'c', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, { say: 'Done.' }] }] }),
    );
    const queue = new StudioQueue(join(folder, '.frame-studio'), async () => join(folder, 'scenes/hello.json'));
    const asking = await queue.create({ selection: { sceneId: 'hello', from: 0, to: 72 }, frame: 0, prompt: 'ask me', references: [], agent: 'fake', settings: { access: 'studio' } });
    await expect.poll(async () => (await queue.get(asking.id)).turns[0].waitingSince !== undefined, { timeout: 30_000 }).toBe(true);

    const viewer = await viewerWindow(app!);
    const switcher = viewer.locator('.switcher-btn');
    await switcher.click();
    await viewer.getByRole('menuitem', { name: /My Film/ }).click();
    await expect.poll(() => switcher.textContent(), { timeout: 30_000 }).toContain('My Film');
    await expect.poll(() => switcher.locator('[aria-label="Another project waits on your input"]').count(), { timeout: 10_000 }).toBe(1);
    await switcher.click();
    const sampleItem = viewer.getByRole('menuitem', { name: /Sample/ });
    await expect.poll(async () => sampleItem.locator('[title$="waiting on your input"]').count(), { timeout: 10_000 }).toBe(1);
    await sampleItem.click();
    await expect.poll(() => switcher.textContent(), { timeout: 30_000 }).toContain('Sample');
    await viewer.waitForFunction(() => (window as unknown as { studio?: { scenes: string[] } }).studio?.scenes !== undefined, undefined, { timeout: 30_000 });
    // The thread waits where it was; open it and answer.
    await viewer.getByRole('navigation', { name: 'Studio' }).getByRole('article', { name: `Request ${asking.id}` }).getByRole('button').click();
    const card = viewer.getByRole('region', { name: 'Questions from the agent' });
    await card.getByRole('radio', { name: /Blue/ }).click();
    await expect.poll(async () => (await queue.get(asking.id)).status, { timeout: 30_000 }).toBe('your_turn');
  });

  it('reopens the last project on the next launch', async () => {
    await app!.close();
    app = await launch();
    const viewer = await viewerWindow(app);
    expect(await viewer.evaluate(() => (window as unknown as { studio: { scenes: string[] } }).studio.scenes)).toContain('bears-story/film');
    expect(app.windows().some((w) => w.url().endsWith('welcome.html'))).toBe(false);
  });
});
