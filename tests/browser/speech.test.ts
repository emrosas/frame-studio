/**
 * Generate Voice and folder trust in the app, from the repo's sources (ADR
 * 0017). A fake provider stands in for ElevenLabs on a loopback port, and
 * Kokoro is faked, so nothing costs anything or downloads.
 *
 * - The key goes in through main's own window and comes out only in the request
 *   to the provider. A sweep looks for it everywhere else it could land.
 * - A generation stops at the native dialog, and writes into media/.
 * - Removing a key asks, and the key is gone.
 * - A project with code asks once. Without trust its rigs never run, and the
 *   viewer says why its scene can't draw. A change asks again, and trust can be
 *   revoked from Settings.
 * - In a browser there's no key store: Kokoro only.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from '../../tools/studio/electron-worker';
import { REPO } from '../../tools/studio/folder';
import { launchBrowser } from './browser';
import { startStudio } from './studio-server';

const KEY = 'sk_test_never_leaves_main_7Q2x';
const home = mkdtempSync(join(tmpdir(), 'frame-studio-voice-home-'));
const userData = join(home, 'userdata');
const project = join(home, 'keyed');
const coded = join(home, 'coded');
const marker = join(coded, 'ran.txt');

let provider: Server;
let requests: { url: string; key: string; body: string }[] = [];
let answer: { status: number; body: string } = { status: 200, body: '' };
let app: ElectronApplication | null = null;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => done(text));
  });

function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  return _electron.launch({
    executablePath: electronBinary(),
    // The mock keychain keeps safeStorage from prompting for your login keychain.
    args: [join(REPO, 'desktop/main.ts'), '--use-mock-keychain'],
    env: { ...env, FRAME_STUDIO_HOME: home, FRAME_STUDIO_USER_DATA: userData, FRAME_STUDIO_BACKGROUND: '1', FRAME_STUDIO_FAKE_AGENT: '1', FRAME_STUDIO_FAKE_KOKORO: '1', FRAME_STUDIO_WARM_MS: '0', FRAME_STUDIO_FAKE_PROVIDER: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, ...extraEnv },
  });
}

/** Answers native dialogs by button, and keeps what each said. */
async function answerDialogs(electron: ElectronApplication, folder?: string): Promise<void> {
  await electron.evaluate(({ dialog }, picked) => {
    const state = globalThis as unknown as { shown: { message: string; detail: string }[]; answer: string; picked?: string };
    state.shown = [];
    state.answer = 'Cancel';
    state.picked = picked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail: string; buttons: string[] };
      state.shown.push({ message: options.message, detail: options.detail });
      return { response: Math.max(0, options.buttons.indexOf(state.answer)), checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [state.picked!] })) as unknown as typeof dialog.showOpenDialog;
  }, folder);
}

const setAnswer = (electron: ElectronApplication, button: string) => electron.evaluate((_, value) => void ((globalThis as unknown as { answer: string }).answer = value), button);
const dialogs = (electron: ElectronApplication) => electron.evaluate(() => (globalThis as unknown as { shown: { message: string; detail: string }[] }).shown);

async function viewerWindow(electron: ElectronApplication): Promise<Page> {
  const isViewer = (p: Page) => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(p.url());
  const page = electron.windows().find((w) => isViewer(w) && !w.isClosed()) ?? (await electron.waitForEvent('window', { predicate: isViewer, timeout: 60_000 }));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined, undefined, { timeout: 60_000 });
  return page;
}

/** Every file under `dir`, for the sweep. */
function everyFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) everyFile(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** The files holding `text`, read as bytes so nothing is skipped for looking binary. */
const holding = (text: string, ...dirs: string[]) => dirs.flatMap((dir) => everyFile(dir)).filter((file) => readFileSync(file).includes(text));

const discovery = (folder: string) => JSON.parse(readFileSync(join(folder, '.frame-studio/server.json'), 'utf8')) as { url: string; token: string };

beforeAll(async () => {
  execFileSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: REPO, stdio: 'ignore' });
  provider = createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push({ url: req.url ?? '', key: String(req.headers['xi-api-key'] ?? ''), body });
      res.statusCode = answer.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(answer.body);
    });
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  answer = {
    status: 200,
    body: JSON.stringify({
      audio_base64: Buffer.from('fake mp3 bytes').toString('base64'),
      alignment: { characters: [...'Hi you'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
    }),
  };
  mkdirSync(join(project, 'scenes'), { recursive: true });
  writeFileSync(join(project, 'scenes/plain.json'), JSON.stringify({ id: 'plain', fps: 24, duration: 2, size: [640, 360], seed: 1, background: { rig: 'paper' }, layers: [] }));
  mkdirSync(join(coded, 'scenes'), { recursive: true });
  mkdirSync(join(coded, 'rigs'), { recursive: true });
  writeFileSync(join(coded, 'scenes/own.json'), JSON.stringify({ id: 'own', fps: 24, duration: 2, size: [640, 360], seed: 1, background: { rig: 'paper' }, layers: [{ id: 'm', rig: 'marked' }] }));
  writeFileSync(join(coded, 'rigs/marked.ts'), `globalThis.process?.getBuiltinModule?.('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
export const marked = { id: 'marked', description: 'Marks that it ran.', params: {}, draw() {} };
`);
});

afterAll(async () => {
  await app?.close().catch(() => {});
  provider?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('provider keys and Generate Voice in the app', () => {
  let viewer: Page;

  it('opens a project with no code without asking', async () => {
    app = await launch();
    const welcome = await app.firstWindow();
    await answerDialogs(app, project);
    await welcome.getByRole('button', { name: /Open/ }).first().waitFor();
    // The welcome window closes under this call.
    await welcome.evaluate(() => void (window as unknown as { frameStudioWelcome: { openFolder(): Promise<unknown> } }).frameStudioWelcome.openFolder()).catch(() => {});
    viewer = await viewerWindow(app);
    expect(await dialogs(app)).toEqual([]);
    // The bridge offers voice and trust, and no call returns a key.
    expect(await viewer.evaluate(() => Object.keys((window as unknown as { frameStudioDesktop: { voice: object } }).frameStudioDesktop.voice).sort())).toEqual(['addKey', 'generate', 'providers', 'removeKey']);
  });

  it('shows an unkeyed provider asking for a key', async () => {
    await viewer.getByRole('button', { name: 'New', exact: true }).click();
    await viewer.getByRole('menuitem', { name: 'Generate voice…' }).click();
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    await sheet.getByRole('radio', { name: 'ElevenLabs' }).click();
    await sheet.getByRole('button', { name: 'Add key' }).waitFor();
  });

  it('takes a key in a window of its own, which the viewer has no part in', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    const opened = app!.waitForEvent('window', { predicate: (p) => p.url().endsWith('key-window.html') });
    await sheet.getByRole('button', { name: 'Add key' }).click();
    const entry = await opened;
    await entry.getByRole('heading', { name: 'Add a ElevenLabs key' }).or(entry.locator('h1')).first().waitFor();
    // Refused: no key shape.
    await entry.getByLabel('API key').fill('nope');
    await entry.getByRole('button', { name: 'Save key' }).click();
    await entry.getByRole('alert').getByText('look like an API key').waitFor();
    await entry.getByLabel('API key').fill(KEY);
    const closed = entry.waitForEvent('close');
    await entry.getByRole('button', { name: 'Save key' }).click();
    await closed;
    await sheet.getByRole('radiogroup', { name: 'Voice' }).waitFor();
    const file = join(userData, 'keys.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
  });

  it('stops at the native dialog, and spends nothing on Cancel', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    await sheet.getByLabel('Text').fill('Hi you');
    await sheet.getByLabel('Language').selectOption('es');
    await sheet.getByRole('radio', { name: /Adam/ }).click();
    await sheet.getByText('Under $0.01 for 6 characters').waitFor();
    await setAnswer(app!, 'Cancel');
    await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await dialogs(app!)).length).toBe(1);
    const [shown] = await dialogs(app!);
    expect(shown.message).toBe('Generate voice with ElevenLabs?');
    expect(shown.detail).toContain('Voice: Adam, Spanish');
    expect(shown.detail).toContain('Hi you');
    expect(shown.detail).toContain('under $0.01');
    expect(requests).toEqual([]);
    expect(existsSync(join(project, 'media'))).toBe(false);
  });

  it('calls the pinned host once with the key, and lands a file in media/', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    await setAnswer(app!, 'Generate');
    await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
    await sheet.getByRole('status').getByText(/Saved as media\/voice-elevenlabs-/).waitFor();
    expect(requests).toHaveLength(1);
    expect(requests[0].key).toBe(KEY);
    expect(requests[0].url).toContain('/with-timestamps');
    const saved = readdirSync(join(project, 'media'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^voice-elevenlabs-.*\.mp3$/);
    expect(readFileSync(join(project, 'media', saved[0]), 'utf8')).toBe('fake mp3 bytes');
  });

  it('reports a refused key by its status, and saves nothing', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    const before = readdirSync(join(project, 'media'));
    const good = answer;
    answer = { status: 401, body: JSON.stringify({ detail: `bad key ${KEY}` }) };
    await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
    await sheet.getByRole('alert').getByText('ElevenLabs refused the key (401).').waitFor();
    answer = good;
    expect(readdirSync(join(project, 'media'))).toEqual(before);
  });

  it("says when it can't read the key file, instead of blaming the provider", async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    const keys = join(userData, 'keys.json');
    const asked = requests.length;
    chmodSync(keys, 0);
    try {
      await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
      await sheet.getByRole('alert').getByText(/can't read its key file/).waitFor();
    } finally {
      chmodSync(keys, 0o600);
    }
    expect(requests).toHaveLength(asked);
  });

  it('places a generated file at the playhead', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
    await sheet.getByRole('button', { name: 'Place at playhead' }).click();
    await sheet.getByText('Placed at the playhead.').waitFor();
    const scene = JSON.parse(readFileSync(join(project, 'scenes/plain.json'), 'utf8')) as { audio: { file: string; script?: string; lang?: string; words?: unknown[] }[] };
    expect(scene.audio[0].file).toMatch(/^media\/voice-elevenlabs-/);
    // The provider timed it, so the words go straight in, with no timing job.
    expect(scene.audio[0].script).toBe('Hi you');
    expect(scene.audio[0].lang).toBe('es');
    expect(scene.audio[0].words).toEqual([
      { id: 'w0', text: 'Hi', start: 0, end: 0.2, p: 1 },
      { id: 'w1', text: 'you', start: 0.3, end: 0.6, p: 1 },
    ]);
    await viewer.getByRole('status', { name: 'Voice timing' }).waitFor({ state: 'detached' });
  });

  it('offers Kokoro with its size and licences, downloads it, and speaks', async () => {
    const sheet = viewer.getByRole('dialog', { name: 'Generate voice' });
    await sheet.getByRole('radio', { name: 'Kokoro' }).click();
    await sheet.getByText('GPL 3.0').waitFor();
    await sheet.getByRole('button', { name: 'Download Kokoro' }).click();
    await sheet.getByRole('radiogroup', { name: 'Voice' }).waitFor();
    await sheet.getByRole('radio', { name: /Dora/ }).click();
    await sheet.getByText('Free, on this computer').waitFor();
    const before = (await dialogs(app!)).length;
    await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
    await sheet.getByRole('status').getByText(/Saved as media\/voice-kokoro-/).waitFor();
    // Nothing to spend, so no dialog.
    expect((await dialogs(app!)).length).toBe(before);
    await sheet.getByRole('button', { name: 'Close' }).click();
  });

  it('gives agents Kokoro, and nothing that touches a key', async () => {
    const { url, token } = discovery(project);
    const client = new Client({ name: 'voice-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/__studio/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: url } } }));
    try {
      const tools = (await client.listTools()).tools;
      const tool = tools.find((t) => t.name === 'generate_voice')!;
      expect(tool.description).toContain('ef_dora');
      expect(tool.inputSchema.properties).not.toHaveProperty('provider');
      const spoken = (await client.callTool({ name: 'generate_voice', arguments: { text: 'Hola', lang: 'es' } })) as CallToolResult;
      const text = spoken.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      expect(spoken.isError).toBeFalsy();
      expect(text).toMatch(/media\/voice-kokoro-/);
      expect(text).not.toContain(KEY);
      const media = (await client.callTool({ name: 'list_media', arguments: {} })) as CallToolResult;
      expect(JSON.stringify(media)).not.toContain(KEY);
    } finally {
      await client.close();
    }
  });

  it('shows the key back as provider, last four and date, in Settings', async () => {
    await viewer.getByRole('button', { name: 'View', exact: true }).click();
    await viewer.getByRole('button', { name: 'Settings…' }).click();
    const settings = viewer.getByRole('dialog', { name: 'Settings' });
    await settings.getByText(/Key ending 7Q2x, added \d{4}-\d{2}-\d{2}/).waitFor();
    await settings.getByRole('link', { name: 'Revoke at ElevenLabs' }).waitFor();
  });

  it('never lets the key land anywhere but the encrypted store', async () => {
    const { url, token } = discovery(project);
    // A thread, so thread files exist to look through.
    await fetch(`${url}/__studio/requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ selection: { sceneId: 'plain', from: 0, to: 1 }, frame: 0, prompt: 'hello', references: [] }),
    });
    expect(await viewer.evaluate((key) => JSON.stringify((window as unknown as { frameStudioDesktop: { boot: unknown } }).frameStudioDesktop.boot).includes(key), KEY)).toBe(false);
    const listed = await viewer.evaluate(() => (window as unknown as { frameStudioDesktop: { voice: { providers(): Promise<unknown> } } }).frameStudioDesktop.voice.providers());
    expect(JSON.stringify(listed)).not.toContain(KEY);
    const rest = await (await fetch(`${url}/__studio/speech`, { headers: { Authorization: `Bearer ${token}` } })).text();
    expect(rest).not.toContain(KEY);
    expect(existsSync(join(userData, 'settings.json'))).toBe(true);
    // Settings, logs, the project with its thread files, and Chromium's own stores.
    expect(holding(KEY, userData, project)).toEqual([]);
    expect(holding(KEY.slice(0, 16), project)).toEqual([]);
  });

  it('gives the render worker, which runs rigs too, no bridge at all', async () => {
    const worker = app!.windows().find((p) => p.url().includes('render.html'));
    expect(worker).toBeDefined();
    expect(await worker!.evaluate(() => typeof (window as unknown as { frameStudioDesktop?: object }).frameStudioDesktop)).toBe('undefined');
  });

  it('asks before removing a key, then forgets it', async () => {
    const settings = viewer.getByRole('dialog', { name: 'Settings' });
    await setAnswer(app!, 'Cancel');
    await settings.getByRole('button', { name: 'Remove ElevenLabs key' }).click();
    await expect.poll(async () => (await dialogs(app!)).at(-1)?.message).toBe('Remove your ElevenLabs key?');
    await settings.getByText(/Key ending 7Q2x/).waitFor();
    await setAnswer(app!, 'Remove');
    const keys = join(userData, 'keys.json');
    chmodSync(keys, 0);
    try {
      await settings.getByRole('button', { name: 'Remove ElevenLabs key' }).click();
      await expect.poll(async () => (await dialogs(app!)).at(-1)?.message).toBe('Your ElevenLabs key is still on this computer.');
      await settings.getByRole('alert').getByText(/can't read its key file/).waitFor();
    } finally {
      chmodSync(keys, 0o600);
    }
    await settings.getByRole('button', { name: 'Close' }).click();
    await viewer.getByRole('button', { name: 'View', exact: true }).click();
    await viewer.getByRole('button', { name: 'Settings…' }).click();
    await settings.getByRole('button', { name: 'Remove ElevenLabs key' }).click();
    await settings.getByText('No key').waitFor();
    expect(readFileSync(join(userData, 'keys.json'), 'utf8')).not.toContain('7Q2x');
    await settings.getByRole('button', { name: 'Close' }).click();
  });
});

describe('trusting a project', () => {
  const real = () => realpathSync(coded);
  const pickFolder = (viewer: Page) => viewer.evaluate(() => void (window as unknown as { frameStudioDesktop: { openFolder(): Promise<unknown> } }).frameStudioDesktop.openFolder()).catch(() => {});

  it('asks before any of its code runs, and opens without it', async () => {
    const viewer = await viewerWindow(app!);
    await answerDialogs(app!, coded);
    await setAnswer(app!, 'Open Without Its Code');
    await pickFolder(viewer);
    await expect.poll(async () => (await dialogs(app!)).at(-1)?.message).toBe('This project contains code.');
    await expect.poll(() => existsSync(join(coded, '.frame-studio/server.json')), { timeout: 30_000 }).toBe(true);
    const page = await viewerWindow(app!);
    await page.getByText("This project's code isn't loaded", { exact: false }).first().waitFor();
    expect(existsSync(marker)).toBe(false);
    const { url, token } = discovery(coded);
    const headers = { Authorization: `Bearer ${token}` };
    const files = (await (await fetch(`${url}/__studio/files`, { headers })).json()) as { withheldCode: number };
    expect(files.withheldCode).toBe(1);
    const modules = (await (await fetch(`${url}/__studio/modules`, { headers })).json()) as { modules: { folderRigs: string[] } };
    expect(modules.modules.folderRigs).toEqual([]);
    expect((await fetch(`${url}/__studio/m/f/rigs/marked.ts`, { headers })).status).toBe(404);
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).trust?.[real()]).toBeUndefined();
  });

  it('runs it once you trust it, and remembers', async () => {
    const viewer = await viewerWindow(app!);
    await setAnswer(app!, 'Trust');
    await viewer.getByRole('button', { name: 'Trust this project…' }).first().click();
    await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).trust?.[real()]?.hash, { timeout: 10_000 }).toMatch(/^[0-9a-f]{64}$/);
  });

  /** Switches to the plain project and waits for this one's server to stop. */
  async function leave(): Promise<void> {
    await answerDialogs(app!, project);
    await pickFolder(await viewerWindow(app!));
    await expect.poll(() => existsSync(join(coded, '.frame-studio/server.json')), { timeout: 30_000 }).toBe(false);
  }

  async function comeBack(button: string): Promise<void> {
    await answerDialogs(app!, coded);
    await setAnswer(app!, button);
    await pickFolder(await viewerWindow(app!));
    await expect.poll(() => existsSync(join(coded, '.frame-studio/server.json')), { timeout: 30_000 }).toBe(true);
  }

  it("doesn't ask about what changed while it was open and trusted", async () => {
    writeFileSync(join(coded, 'rigs/extra.ts'), 'export const written = "by an agent, say";\n');
    await leave();
    await comeBack('Cancel');
    expect(await dialogs(app!)).toEqual([]);
  });

  it('asks again when the code changes while the project is closed', async () => {
    await leave();
    rmSync(marker, { force: true });
    writeFileSync(join(coded, 'rigs/extra.ts'), 'export const written = "by someone else";\n');
    await comeBack('Open Without Its Code');
    expect((await dialogs(app!)).map((d) => d.message)).toEqual(['This project contains code.']);
    await (await viewerWindow(app!)).getByText("This project's code isn't loaded", { exact: false }).first().waitFor();
    expect(existsSync(marker)).toBe(false);
  });

  it('takes trust back from Settings, without asking again', async () => {
    const viewer = await viewerWindow(app!);
    await setAnswer(app!, 'Trust');
    await viewer.getByRole('button', { name: 'Trust this project…' }).first().click();
    await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true);
    rmSync(marker, { force: true });
    const now = await viewerWindow(app!);
    await now.getByRole('button', { name: 'View', exact: true }).click();
    await now.getByRole('button', { name: 'Settings…' }).click();
    const dialog = now.getByRole('dialog', { name: 'Settings' });
    await setAnswer(app!, 'Cancel');
    await dialog.getByRole('button', { name: 'Revoke trust in coded' }).click();
    await expect.poll(async () => (await dialogs(app!)).at(-1)?.message).toBe('Stop trusting coded?');
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).trust?.[real()]).toBeDefined();
    await setAnswer(app!, 'Stop Trusting');
    await dialog.getByRole('button', { name: 'Revoke trust in coded' }).click();
    await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).trust?.[real()], { timeout: 10_000 }).toBeUndefined();
    await (await viewerWindow(app!)).getByText("This project's code isn't loaded", { exact: false }).first().waitFor({ timeout: 30_000 });
    const after = (await dialogs(app!)).map((d) => d.message);
    expect(after.filter((m) => m === 'Stop trusting coded?')).toHaveLength(2);
    expect(after.at(-1)).toBe('Stop trusting coded?');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('in a browser', () => {
  it('has no key store: Kokoro is the one provider', async () => {
    const studio = await startStudio({ hmr: true });
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(studio.paired());
      await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Generate voice…' }).click();
      const sheet = page.getByRole('dialog', { name: 'Generate voice' });
      await sheet.getByRole('radio', { name: 'Kokoro' }).waitFor();
      expect(await sheet.getByRole('radiogroup', { name: 'Provider' }).getByRole('radio').count()).toBe(1);
      await sheet.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await page.getByRole('button', { name: 'Settings…' }).click();
      await page.getByRole('dialog', { name: 'Settings' }).getByText('In a browser, Kokoro is the voice.').waitFor();
    } finally {
      await browser.close();
      await studio.close();
    }
  });
});
