/**
 * M5: the MCP server, driven as a coding agent would drive it: a fresh MCP
 * client session over stdio, running `node tools/mcp/server.ts`.
 *
 * The scene is a copy of bear-test written to scenes/mcp-test-<pid>.json
 * (gitignored) and removed afterwards, so the real scenes are never edited.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../tools/scene-files';
import { StudioQueue } from '../../tools/studio/queue';

const ID = `mcp-test-${process.pid}`;
const SCENE_FILE = join(ROOT, 'scenes', `${ID}.json`);
const OUT_DIR = join(ROOT, 'out', ID);
/** A throwaway handoff folder, so the tests never see or touch a real queue. */
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-handoff-'));
/** The viewer's side of the queue, as its studio server would use it. */
const viewerQueue = new StudioQueue(STUDIO, async () => SCENE_FILE);

let client: Client;

beforeAll(async () => {
  const scene = JSON.parse(readFileSync(join(ROOT, 'scenes/bear-test.json'), 'utf8'));
  writeFileSync(SCENE_FILE, `${JSON.stringify({ ...scene, id: ID }, null, 2)}\n`);
  client = new Client({ name: 'frame-studio-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['tools/mcp/server.ts'],
      cwd: ROOT,
      stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), FRAME_STUDIO_DIR: STUDIO },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  rmSync(SCENE_FILE, { force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });
  rmSync(STUDIO, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function json<T>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

/** SHA-256 of the RGBA pixels of the image a render tool returned. */
async function imageHash(result: CallToolResult): Promise<string> {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`);
  const image = result.content.find((c) => c.type === 'image');
  if (!image || image.type !== 'image') throw new Error('no image in the result');
  const decoded = await loadImage(Buffer.from(image.data, 'base64'));
  const canvas = createCanvas(decoded.width, decoded.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(decoded, 0, 0);
  return createHash('sha256').update(ctx.getImageData(0, 0, decoded.width, decoded.height).data).digest('hex');
}

const render = (frame: number | string) => call('render_frame', { sceneId: ID, frame, maxWidth: 480 });

describe('an agent session', () => {
  it('lists the tools CLAUDE.md names', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'apply_to_selection',
        'complete_request',
        'export',
        'get_request',
        'get_scene',
        'get_selection',
        'hit_test',
        'list_rigs',
        'list_scenes',
        'next_request',
        'render_contact_sheet',
        'render_frame',
        'update_scene',
      ].sort(),
    );
  });

  it('lists scenes and rigs', async () => {
    const scenes = json<{ id: string; frameCount?: number; layers?: { id: string }[]; errors: string[] }[]>(await call('list_scenes'));
    const mine = scenes.find((s) => s.id === ID);
    expect(mine).toMatchObject({ frameCount: 96, errors: [] });
    expect(mine?.layers?.map((l) => l.id)).toEqual(['background', 'bruno', 'pip']);
    const rigs = json<{ id: string; variants: string[]; parts: string[]; base: string | null; params: Record<string, { description?: string }> }[]>(await call('list_rigs'));
    const bear = rigs.find((r) => r.id === 'bear');
    expect(bear?.variants).toEqual(expect.arrayContaining(['bear.bandaged', 'bear.blush']));
    expect(bear?.parts).toContain('muzzle');
    expect(bear?.params.body.description).toMatch(/colour/);
    expect(rigs.find((r) => r.id === 'bear.bandaged')?.base).toBe('bear');
  });

  it('renders a frame, hit-tests the character, edits a range and sees the change only inside it', async () => {
    const frames = [11, 12, 23, 24];
    const before = new Map<number, string>();
    for (const f of frames) before.set(f, await imageHash(await render(f)));

    const hit = json<{ layerId: string; partId?: string; frame: number }>(await call('hit_test', { sceneId: ID, frame: '00:02:06', x: 760, y: 900 }));
    expect(hit).toMatchObject({ frame: 30, layerId: 'bruno', partId: 'body' });

    const applied = json<{ layers: { layerId: string; overrides: unknown[] }[]; note?: string }>(
      await call('apply_to_selection', {
        selection: { sceneId: ID, layerId: hit.layerId, partId: hit.partId, from: 12, to: '00:02:00' },
        patch: { params: { body: '#3355ff' } },
      }),
    );
    expect(applied.layers[0].overrides).toContainEqual({ from: 12, to: 24, params: { body: '#3355ff' } });
    expect(applied.note).toMatch(/whole layer/);

    const after = new Map<number, string>();
    for (const f of frames) after.set(f, await imageHash(await render(f)));
    expect(after.get(11)).toBe(before.get(11));
    expect(after.get(24)).toBe(before.get(24));
    expect(after.get(12)).not.toBe(before.get(12));
    expect(after.get(23)).not.toBe(before.get(23));
  });

  it('keeps an override working around a scoped edit inside it', async () => {
    json(await call('apply_to_selection', { selection: { sceneId: ID, layerId: 'bruno', from: 60, to: 66 }, patch: { params: { expression: 'sad' } } }));
    const scene = json<{ scene: { layers: { id: string; overrides?: unknown[] }[] } }>(await call('get_scene', { id: ID })).scene;
    expect(scene.layers.find((l) => l.id === 'bruno')?.overrides).toEqual([
      { from: 12, to: 24, params: { body: '#3355ff' } },
      { from: 48, to: 60, rig: 'bear.bandaged' },
      { from: 60, to: 66, rig: 'bear.bandaged', params: { expression: 'sad' } },
      { from: 66, to: 72, rig: 'bear.bandaged' },
    ]);
  });

  it('with no layerId, edits every layer whose rig takes the params, over the whole range', async () => {
    const applied = json<{ layers: { layerId: string }[] }>(
      await call('apply_to_selection', { selection: { sceneId: ID, from: 90, to: 96 }, patch: { params: { pose: 'cheer' } } }),
    );
    expect(applied.layers.map((l) => l.layerId)).toEqual(['bruno', 'pip']);
    const scene = json<{ scene: { background: { overrides?: unknown[] }; layers: { id: string; overrides?: { from: number }[] }[] } }>(
      await call('get_scene', { id: ID }),
    ).scene;
    expect(scene.background.overrides).toBeUndefined();
    for (const layer of scene.layers) expect(layer.overrides?.some((o) => o.from === 90)).toBe(true);
    const swap = await call('apply_to_selection', { selection: { sceneId: ID, from: 0, to: 4 }, patch: { rig: 'bear.bandaged' } });
    expect(textOf(swap)).toMatch(/rig swap needs a layerId/);
  });

  it('runs tool calls one at a time, so parallel renders come back right', async () => {
    const serial = [await imageHash(await render(5)), await imageHash(await render(50))];
    const parallel = await Promise.all([render(5), render(50), call('list_scenes'), render(5)]);
    expect(await imageHash(parallel[0])).toBe(serial[0]);
    expect(await imageHash(parallel[1])).toBe(serial[1]);
    expect(await imageHash(parallel[3])).toBe(serial[0]);
  });

  it('updates a scene with a merge patch, and refuses an invalid one without saving', async () => {
    const saved = readFileSync(SCENE_FILE, 'utf8');
    const bad = await call('update_scene', { id: ID, patch: { fps: 0 } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/invalid, so nothing was saved[\s\S]*fps/);
    expect(readFileSync(SCENE_FILE, 'utf8')).toBe(saved);
    expect((await call('update_scene', { id: ID, patch: { id: 'renamed' } })).isError).toBe(true);

    const ok = json<{ scene: { background: { params: { tone: string } } } }>(await call('update_scene', { id: ID, patch: { background: { params: { tone: '#223344' } } } }));
    expect(ok.scene.background.params.tone).toBe('#223344');
    // Formatted the way the studio writes scenes: short objects on one line.
    expect(readFileSync(SCENE_FILE, 'utf8')).toContain('"size": [1920, 1080]');
  });

  it('shows a readable error for a bad scene id or frame', async () => {
    const missing = await render(0).then(() => call('render_frame', { sceneId: 'nope', frame: 0 }));
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No scene "nope"/);
    const late = await call('render_frame', { sceneId: ID, frame: 96 });
    expect(late.isError).toBe(true);
    expect(textOf(late)).toMatch(/\[0, 96\)/);
  });

  it('renders a contact sheet', async () => {
    const r = await call('render_contact_sheet', { sceneId: ID, every: 24 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/frames 0, 24, 48, 72/);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('exports all three targets', async () => {
    // html first, into an out/ folder that does not exist yet.
    rmSync(OUT_DIR, { recursive: true, force: true });
    const html = json<{ file: string; rigs: string[] }>(await call('export', { sceneId: ID, target: 'html' }));
    expect(html.rigs).toEqual(['bear', 'bear.bandaged', 'paper']);
    const page = readFileSync(join(ROOT, html.file), 'utf8');
    expect(page).toContain('<div id="frame-studio"></div>');
    expect(page).not.toMatch(/https?:\/\//);

    const mp4 = json<{ file: string; frames: number; seconds: number }>(await call('export', { sceneId: ID, target: 'mp4' }));
    expect(mp4).toMatchObject({ file: `out/${ID}/${ID}.mp4`, frames: 96, seconds: 8 });
    const input = new Input({ source: new BufferSource(readFileSync(join(ROOT, mp4.file))), formats: ALL_FORMATS });
    expect((await (await input.getPrimaryVideoTrack())!.computePacketStats()).packetCount).toBe(96);

    const gif = json<{ file: string; frames: number }>(await call('export', { sceneId: ID, target: 'gif', from: 0, to: 12 }));
    expect(gif).toMatchObject({ file: `out/${ID}/${ID}-00000-00012.gif`, frames: 12 });
    expect(existsSync(join(ROOT, gif.file))).toBe(true);
  });
});

describe('the request queue (M6)', () => {
  it('works a viewer request end to end: background over [1, 14), only those frames change, and Revert restores it', async () => {
    const original = readFileSync(SCENE_FILE, 'utf8');
    const before = new Map<number, string>();
    for (const f of [0, 1, 13, 14]) before.set(f, await imageHash(await render(f)));

    // The viewer sends a request for the background over frames 1 to 14.
    const sent = await viewerQueue.create({
      selection: { sceneId: ID, layerId: 'background', from: 1, to: 14 },
      frame: 5,
      prompt: 'make the ground a deep blue for the first second',
      references: [],
    });

    // The agent takes it, reads it, and does it.
    const taken = await call('next_request');
    const described = textOf(taken);
    expect(described).toContain(`Frame Studio request #${sent.id}`);
    expect(described).toContain('Prompt: make the ground a deep blue for the first second');
    expect(described).toContain('layer background, frames [1, 14)');
    expect(described).toMatch(/complete_request with id \d+/);
    expect((await viewerQueue.get(sent.id)).status).toBe('in_progress');
    json(await call('apply_to_selection', { selection: { ...sent.selection }, patch: { params: { tone: '#1d3a8a' } } }));
    const done = json<{ status: string; summary: string }>(
      await call('complete_request', { id: sent.id, status: 'done', summary: 'set the ground to #1d3a8a over frames 1 to 14' }),
    );
    expect(done).toMatchObject({ status: 'done', summary: 'set the ground to #1d3a8a over frames 1 to 14' });

    const after = new Map<number, string>();
    for (const f of [0, 1, 13, 14]) after.set(f, await imageHash(await render(f)));
    expect(after.get(0)).toBe(before.get(0));
    expect(after.get(14)).toBe(before.get(14));
    expect(after.get(1)).not.toBe(before.get(1));
    expect(after.get(13)).not.toBe(before.get(13));

    // Revert puts the scene back byte for byte, and the frames with it.
    await viewerQueue.revert(sent.id);
    expect(readFileSync(SCENE_FILE, 'utf8')).toBe(original);
    expect(await imageHash(await render(1))).toBe(before.get(1));
  });

  it('claims a pasted request by id, serves the /next prompt, and reports an empty queue plainly', async () => {
    const pasted = await viewerQueue.create({ selection: { sceneId: ID, layerId: 'pip', from: 0, to: 12 }, frame: 0, prompt: 'wave', references: [] });
    expect(textOf(await call('get_request', { id: pasted.id }))).toContain('Status: in progress.');
    expect((await viewerQueue.get(pasted.id)).checkpoint).toBe(true);
    json(await call('complete_request', { id: pasted.id, status: 'failed', summary: 'could not find a wave pose' }));

    const queued = await viewerQueue.create({ selection: { sceneId: ID, from: 0, to: 4 }, frame: 0, prompt: 'redo these frames', references: ['references/x.png'] });
    const prompt = await client.getPrompt({ name: 'next' });
    const message = prompt.messages[0].content;
    expect(message.type === 'text' && message.text).toContain(`request #${queued.id}`);
    expect(message.type === 'text' && message.text).toContain('all layers (a whole-frame-range selection)');
    expect(message.type === 'text' && message.text).toContain('references/x.png');
    expect(textOf(await call('next_request'))).toMatch(/no pending Frame Studio requests/);
    const late = await call('complete_request', { id: 999, status: 'done', summary: 'x' });
    expect(late.isError).toBe(true);
    expect(textOf(late)).toMatch(/no request #999/);
  });

  it('serves the current selection as a tool and an @-mentionable resource', async () => {
    expect(textOf(await call('get_selection'))).toBe('Nothing is selected in the viewer.');
    await viewerQueue.writeSelection({ sceneId: ID, layerId: 'bruno', partId: 'nose', from: 24, to: 48, frame: 30, point: { x: 760, y: 500 } });
    expect(json<{ layerId: string }>(await call('get_selection')).layerId).toBe('bruno');
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('selection://current');
    const read = await client.readResource({ uri: 'selection://current' });
    const content = read.contents[0];
    expect('text' in content ? JSON.parse(content.text as string) : null).toMatchObject({ partId: 'nose', frame: 30 });
  });
});

