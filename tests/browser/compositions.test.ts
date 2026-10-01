/**
 * M14 (ADR 0013): a project folder with compositions, driven over MCP as an
 * agent would. The folder is projects/bears-story converted into a temporary
 * project folder, so the film is a composition and its shots are scenes; a
 * second session on the repo renders the original film to compare against.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/scene-files';
import { convertFilm } from '../../tools/studio/convert';
import { launchBrowser } from './browser';

const TMP = mkdtempSync(join(tmpdir(), 'frame-studio-compositions-'));
const FOLDER = join(TMP, 'bears');
const STUDIO = join(TMP, 'handoff');

let folderClient: Client;
let repoClient: Client;

async function connect(folder: string): Promise<Client> {
  const client = new Client({ name: 'frame-studio-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'tools/mcp/server.ts'), '--folder', folder],
      cwd: ROOT,
      stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), FRAME_STUDIO_DIR: STUDIO },
    }),
  );
  return client;
}

beforeAll(async () => {
  await convertFilm(join(ROOT, 'projects/bears-story'), FOLDER, ROOT);
  [folderClient, repoClient] = await Promise.all([connect(FOLDER), connect(ROOT)]);
});

afterAll(async () => {
  await Promise.all([folderClient?.close(), repoClient?.close()]);
  rmSync(TMP, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}, client = folderClient): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

function json<T>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

async function imageHash(result: CallToolResult): Promise<string> {
  if (result.isError) throw new Error(`render failed: ${textOf(result)}`);
  const image = result.content.find((c) => c.type === 'image');
  if (!image || image.type !== 'image') throw new Error('no image in the result');
  const decoded = await loadImage(Buffer.from(image.data, 'base64'));
  const canvas = createCanvas(decoded.width, decoded.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(decoded, 0, 0);
  return createHash('sha256').update(ctx.getImageData(0, 0, decoded.width, decoded.height).data).digest('hex');
}

const read = (path: string) => JSON.parse(readFileSync(join(FOLDER, path), 'utf8'));

describe('a project folder with compositions', () => {
  it('lists the film as a composition and its shots as scenes', async () => {
    const scenes = json<{ id: string; kind: string; errors: string[] }[]>(await call('list_scenes'));
    expect(scenes.map((s) => [s.id, s.kind, s.errors.length]).sort()).toEqual([
      ['film', 'composition', 0],
      ['film-background', 'scene', 0],
      ['meet', 'scene', 0],
      ['pip', 'scene', 0],
      ['together', 'scene', 0],
    ]);
  });

  it('renders the converted film exactly as the original', async () => {
    for (const frame of [20, 80, 130]) {
      const converted = await imageHash(await call('render_frame', { sceneId: 'film', frame, maxWidth: 480 }));
      const original = await imageHash(await call('render_frame', { sceneId: 'bears-story/film', frame, maxWidth: 480 }, repoClient));
      expect(converted, `frame ${frame}`).toBe(original);
    }
  });

  it("reads and patches the folder's project.json, and refuses a cast change that breaks a scene", async () => {
    const project = json<{ project: { name: string; fps: number; cast: Record<string, unknown> }; errors: string[] }>(await call('get_project'));
    expect(project.project).toMatchObject({ name: "Bears' story", fps: 12 });
    expect(Object.keys(project.project.cast).sort()).toEqual(['bruno', 'pip']);
    expect(project.errors).toEqual([]);

    const before = await imageHash(await call('render_frame', { sceneId: 'meet', frame: 12, maxWidth: 480 }));
    const saved = await call('update_project', { patch: { cast: { bruno: { params: { body: '#c9a27e' } } } } });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(read('project.json').cast.bruno.params.body).toBe('#c9a27e');
    expect(await imageHash(await call('render_frame', { sceneId: 'meet', frame: 12, maxWidth: 480 }))).not.toBe(before);

    const text = readFileSync(join(FOLDER, 'project.json'), 'utf8');
    expect(textOf(await call('update_project', { patch: { cast: { pip: null } } }))).toMatch(/would break the project[\s\S]*pip\.json: [^\n]*no cast member "pip"/);
    expect(readFileSync(join(FOLDER, 'project.json'), 'utf8')).toBe(text);
  });

  it("creates scenes and compositions in the project's format, and nests a composition in another", async () => {
    expect(json<{ id: string; file: string }>(await call('create_scene', { id: 'title', duration: 2 }))).toMatchObject({ id: 'title', file: 'scenes/title.json' });
    expect(read('scenes/title.json')).toMatchObject({ fps: 12, size: [1920, 1080], layers: [] });
    expect(textOf(await call('create_scene', { id: 'film', duration: 2 }))).toMatch(/already a scene "film"/);

    expect(json<{ id: string; file: string }>(await call('create_composition', { id: 'trailer', duration: 8, size: [1280, 720] }))).toMatchObject({ id: 'trailer', file: 'compositions/trailer.json' });
    expect(read('compositions/trailer.json')).toEqual({ id: 'trailer', fps: 12, duration: 8, size: [1280, 720], background: '#000000', tracks: [{ id: 'V1', clips: [] }] });
    expect(textOf(await call('create_composition', { id: 'meet', duration: 2 }))).toMatch(/already a scene or composition "meet"/);

    // The film, a 1920×1080 composition, inside the 1280×720 trailer: centred, at half size.
    const tracks = [
      { id: 'V1', clips: [{ id: 'cut', scene: 'film', start: 0, in: 2, out: 8, params: { scale: 0.5 } }] },
      { id: 'V2', clips: [{ id: 'title', scene: 'title', start: 6 }] },
    ];
    const saved = await call('update_scene', { id: 'trailer', patch: { tracks } });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    const listed = json<{ id: string; layers?: { id: string; scene?: string }[] }[]>(await call('list_scenes')).find((s) => s.id === 'trailer');
    expect(listed?.layers?.filter((l) => l.scene).map((l) => [l.id, l.scene])).toEqual([
      ['cut', 'film'],
      ['title', 'title'],
    ]);
    const frame = await call('render_frame', { sceneId: 'trailer', frame: 30, maxWidth: 480 });
    expect(frame.isError, textOf(frame)).toBeFalsy();
  });

  it('refuses loops, a clip at another fps, a scene that places one, and an edit that breaks a composition', async () => {
    const film = readFileSync(join(FOLDER, 'compositions/film.json'), 'utf8');
    const loop = await call('update_scene', { id: 'film', patch: { tracks: [{ id: 'V1', clips: [{ id: 't', scene: 'trailer' }] }] } });
    expect(textOf(loop)).toMatch(/loop/);
    expect(readFileSync(join(FOLDER, 'compositions/film.json'), 'utf8')).toBe(film);

    json(await call('create_scene', { id: 'fast', fps: 24, duration: 1 }));
    expect(textOf(await call('update_scene', { id: 'trailer', patch: { tracks: [{ id: 'V1', clips: [{ id: 'f', scene: 'fast' }] }] } }))).toMatch(/runs at 24 fps; a composition's clips run at its own fps \(12\)/);

    expect(textOf(await call('update_scene', { id: 'pip', patch: { layers: [{ id: 'm', scene: 'meet' }] } }))).toMatch(/a scene draws and places nothing/);

    const meet = readFileSync(join(FOLDER, 'scenes/meet.json'), 'utf8');
    expect(textOf(await call('update_scene', { id: 'meet', patch: { fps: 24 } }))).toMatch(/would break the compositions that place it[\s\S]*compositions\/film\.json/);
    expect(readFileSync(join(FOLDER, 'scenes/meet.json'), 'utf8')).toBe(meet);
  });

  it('exports a composition as one HTML file carrying the scenes it places and the cast they use', async () => {
    const result = json<{ file: string }>(await call('export', { sceneId: 'film', target: 'html' }));
    const path = join(FOLDER, result.file);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, 'utf8');
    for (const id of ['meet', 'pip', 'together', 'film-background', 'bruno']) expect(html).toContain(id);

    // It plays from disk with the network off, and draws the clips: frame 130 is mid-iris, two shots at once.
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 960, height: 540 } });
      await context.setOffline(true);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      await page.goto(`${pathToFileURL(path).href}?autoplay=0`);
      await page.waitForFunction(() => 'studio' in window);
      const colours = await page.evaluate(() => {
        const { studio } = window as unknown as { studio: { seek(f: number): number; canvas: HTMLCanvasElement } };
        studio.seek(130);
        const c = studio.canvas;
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < data.length; i += 4 * 997) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        return seen.size;
      });
      expect(problems).toEqual([]);
      expect(colours).toBeGreaterThan(20);
    } finally {
      await browser.close();
    }
  });
});
