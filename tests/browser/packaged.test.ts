/**
 * M10: the packaged app, as npm run desktop:build leaves it in
 * build/desktop/dist/ (ADR 0008). Skipped until it's built. With a temporary
 * settings folder, and new studio folders in a temporary home:
 *
 * - it starts with launchd's short PATH, makes a studio folder, and the viewer
 *   plays a sample drawn by the render worker it ships;
 * - the viewer exports an MP4 into the folder's out/;
 * - its frame-studio-mcp command serves every tool through the running app,
 *   and through a headless server of its own when the app is closed;
 * - it times a voice with the whisper-cli it ships (ADR 0016), when the model
 *   and a sample voice are on this machine.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from '../../tools/studio/folder';

const APP = join(REPO, 'build/desktop/dist/mac-arm64/Frame Studio.app');
const BINARY = join(APP, 'Contents/MacOS/Frame Studio');
const MCP = join(APP, 'Contents/Resources/bin/frame-studio-mcp');
const home = mkdtempSync(join(tmpdir(), 'frame-studio-packaged-'));
const folder = join(home, 'Frame Studio Projects', 'Sample');
let app: ElectronApplication | null = null;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') out[key] = value;
  return { ...out, FRAME_STUDIO_HOME: home, FRAME_STUDIO_USER_DATA: join(home, 'userdata'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

async function viewerWindow(electron: ElectronApplication): Promise<Page> {
  const isViewer = (p: Page) => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(p.url());
  const page = electron.windows().find(isViewer) ?? (await electron.waitForEvent('window', { predicate: isViewer, timeout: 60_000 }));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined, undefined, { timeout: 60_000 });
  return page;
}

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: 'frame-studio-packaged-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: MCP, args: [], cwd: folder, env: env(), stderr: 'pipe' }));
  return client;
}

const MODEL = join(homedir(), '.frame-studio/models/ggml-small-q5_1.bin');
const VOICE = process.env.FRAME_STUDIO_VOICE_SAMPLES ?? '/Users/emireles/git/frame-studio/out/voice-test';

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

afterAll(async () => {
  await app?.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!existsSync(BINARY))('the packaged app', () => {
  it('starts from its own files, makes a studio folder, and plays a sample drawn by its render worker', async () => {
    app = await _electron.launch({ executablePath: BINARY, args: [], env: env() });
    const welcome = await app.firstWindow();
    await welcome.getByRole('button', { name: 'Open the sample project' }).click();
    const viewer = await viewerWindow(app);
    expect(await viewer.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors)).toEqual([]);
    await viewer.evaluate(() => (window as unknown as { studio: { selectScene(id: string): void } }).studio.selectScene('film'));
    expect(await viewer.evaluate(() => (window as unknown as { studio: { frameCount: number } }).studio.frameCount)).toBe(144);
  });

  it('exports an MP4 from the viewer into the folder', async () => {
    const viewer = await viewerWindow(app!);
    await viewer.evaluate(() => (window as unknown as { studio: { selectScene(id: string): void; setRange(a: number, b: number): void } }).studio.selectScene('hello'));
    await viewer.evaluate(() => (window as unknown as { studio: { setRange(a: number, b: number): void } }).studio.setRange(0, 24));
    await viewer.getByRole('button', { name: 'Export', exact: true }).click();
    const panel = viewer.getByRole('region', { name: 'Export' });
    await panel.getByRole('checkbox', { name: 'Only 0:00–0:01' }).check();
    await panel.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(() => panel.getByRole('status').textContent(), { timeout: 60_000 }).toMatch(/Saved hello-00000-00024\.mp4/);
    await expect.poll(() => panel.getByRole('button', { name: 'Reveal in Finder' }).count()).toBe(1);
    const mp4 = readFileSync(join(folder, 'out/hello/hello-00000-00024.mp4'));
    expect(mp4.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('serves the MCP tools through the running app', async () => {
    const client = await mcpClient();
    try {
      const scenes = JSON.parse(textOf((await client.callTool({ name: 'list_scenes', arguments: {} })) as CallToolResult)) as { id: string }[];
      expect(scenes.map((s) => s.id)).toContain('film');
      const frame = (await client.callTool({ name: 'render_frame', arguments: { sceneId: 'film', frame: 50, maxWidth: 320 } })) as CallToolResult;
      expect(frame.isError).toBeFalsy();
      expect(frame.content.some((c) => c.type === 'image')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it.skipIf(!existsSync(MODEL) || !existsSync(join(VOICE, 'eleven-es.mp3')))('times a voice with the whisper-cli it ships', async () => {
    mkdirSync(join(folder, 'media'), { recursive: true });
    copyFileSync(join(VOICE, 'eleven-es.mp3'), join(folder, 'media/voice.mp3'));
    mkdirSync(join(home, '.frame-studio/models'), { recursive: true });
    symlinkSync(MODEL, join(home, '.frame-studio/models/ggml-small-q5_1.bin'));
    const client = await mcpClient();
    try {
      const placed = (await client.callTool({ name: 'update_scene', arguments: { id: 'hello', patch: { audio: [{ id: 'voice', file: 'media/voice.mp3', start: 0, end: 3, lang: 'es' }] } } })) as CallToolResult;
      expect(placed.isError, textOf(placed)).toBeFalsy();
      const timed = (await client.callTool({ name: 'align_voice', arguments: { sceneId: 'hello', cueId: 'voice' } }, undefined, { timeout: 150_000 })) as CallToolResult;
      expect(timed.isError, textOf(timed)).toBeFalsy();
      expect(JSON.parse(textOf(timed))).toMatchObject({ language: 'es' });
      const scene = JSON.parse(readFileSync(join(folder, 'scenes/hello.json'), 'utf8')) as { audio: { words: { text: string }[] }[] };
      expect(scene.audio[0].words.length).toBeGreaterThan(20);
    } finally {
      await client.close();
    }
  });

  it('serves them from a headless server of its own when the app is closed', async () => {
    await app!.close();
    app = null;
    const client = await mcpClient();
    try {
      const frame = (await client.callTool({ name: 'render_frame', arguments: { sceneId: 'hello', frame: 12, maxWidth: 320 } })) as CallToolResult;
      expect(frame.isError, textOf(frame)).toBeFalsy();
      const html = (await client.callTool({ name: 'export', arguments: { sceneId: 'film', target: 'html' } })) as CallToolResult;
      expect(textOf(html)).toMatch(/out\/film\/film\.html/);
    } finally {
      await client.close();
    }
  });
});
