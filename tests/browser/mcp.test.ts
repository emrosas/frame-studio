/**
 * M5: the MCP server, driven as a coding agent would drive it: a fresh MCP
 * client session over stdio, running `node tools/mcp/server.ts`.
 *
 * The scene is a copy of bear-test written to scenes/mcp-test-<pid>.json
 * (gitignored) and removed afterwards, so the real scenes are never edited.
 * The project tools (M9) work on a copy of projects/bears-story in
 * projects/mcp-test-<pid>/, likewise.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PROJECT_DIR = join(ROOT, 'projects', ID);
/** What create_scene makes; gitignored like the rest. */
const NEW_SCENE_FILE = join(ROOT, 'scenes', `${ID}-new.json`);
const NOFPS_FILE = join(ROOT, 'scenes', `${ID}-nofps.json`);
/** A throwaway handoff folder, so the tests never see or touch a real queue. */
const STUDIO = mkdtempSync(join(tmpdir(), 'frame-studio-handoff-'));
/** The viewer's side of the queue, as its studio server would use it. */
const viewerQueue = new StudioQueue(STUDIO, async () => SCENE_FILE);

let client: Client;

beforeAll(async () => {
  const scene = JSON.parse(readFileSync(join(ROOT, 'scenes/bear-test.json'), 'utf8'));
  writeFileSync(SCENE_FILE, `${JSON.stringify({ ...scene, id: ID }, null, 2)}\n`);
  cpSync(join(ROOT, 'projects/bears-story'), PROJECT_DIR, { recursive: true });
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
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  rmSync(NEW_SCENE_FILE, { force: true });
  rmSync(NOFPS_FILE, { force: true });
  rmSync(`${OUT_DIR}-new`, { recursive: true, force: true });
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
        'create_composition',
        'create_scene',
        'export',
        'get_project',
        'get_request',
        'get_scene',
        'get_selection',
        'hit_test',
        'import_media',
        'list_generators',
        'list_media',
        'list_projects',
        'list_rigs',
        'list_scenes',
        'next_request',
        'render_contact_sheet',
        'render_frame',
        'update_project',
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
    const generators = json<{ id: string; params: Record<string, { type: string; description?: string }> }[]>(await call('list_generators'));
    expect(generators.map((g) => g.id).sort()).toEqual(['blip', 'buzz', 'pad']);
    expect(generators.find((g) => g.id === 'blip')?.params.every.description).toMatch(/Seconds between blips/);
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

  it('creates an empty scene that renders, and refuses a taken or malformed name', async () => {
    const made = json<{ id: string; file: string }>(await call('create_scene', { id: `${ID}-new`, fps: 12, size: [640, 360], duration: 2 }));
    expect(made).toMatchObject({ id: `${ID}-new`, file: `scenes/${ID}-new.json` });
    const scene = JSON.parse(readFileSync(NEW_SCENE_FILE, 'utf8'));
    expect(scene).toMatchObject({ id: `${ID}-new`, fps: 12, duration: 2, size: [640, 360], background: { rig: 'paper' }, layers: [] });
    const listed = json<{ id: string; frameCount: number; errors: string[] }[]>(await call('list_scenes')).find((s) => s.id === `${ID}-new`);
    expect(listed).toMatchObject({ frameCount: 24, errors: [] });
    expect((await call('render_frame', { sceneId: `${ID}-new`, frame: 0, maxWidth: 320 })).isError).toBeFalsy();

    expect(textOf(await call('create_scene', { id: ID, fps: 12, size: [640, 360], duration: 2 }))).toMatch(/already a scene/);
    expect(textOf(await call('create_scene', { id: 'Not An Id', fps: 12, size: [640, 360], duration: 2 }))).toMatch(/lowercase letters, digits and single hyphens/);
    expect(textOf(await call('create_scene', { id: `${ID}-new`, fps: 0, duration: 2 }))).toMatch(/fps/);
    // Without fps and size, a scene takes project.json's, and without one the default (ADR 0013).
    json(await call('create_scene', { id: `${ID}-nofps`, duration: 2 }));
    expect(JSON.parse(readFileSync(NOFPS_FILE, 'utf8'))).toMatchObject({ fps: 24, size: [1920, 1080] });
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

describe('the request queue (M6, threads from M8)', () => {
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
    expect((await viewerQueue.get(sent.id)).status).toBe('working');
    json(await call('apply_to_selection', { selection: { ...sent.turns[0].ask.selection }, patch: { params: { tone: '#1d3a8a' } } }));
    const done = json<{ status: string; turns: { status: string; summary: string }[] }>(
      await call('complete_request', { id: sent.id, status: 'done', summary: 'set the ground to #1d3a8a over frames 1 to 14' }),
    );
    expect(done).toMatchObject({ status: 'your_turn', turns: [{ status: 'done', summary: 'set the ground to #1d3a8a over frames 1 to 14' }] });

    const after = new Map<number, string>();
    for (const f of [0, 1, 13, 14]) after.set(f, await imageHash(await render(f)));
    expect(after.get(0)).toBe(before.get(0));
    expect(after.get(14)).toBe(before.get(14));
    expect(after.get(1)).not.toBe(before.get(1));
    expect(after.get(13)).not.toBe(before.get(13));

    // A reply comes back to the agent as the next turn, with the thread so far.
    await viewerQueue.reply(sent.id, { selection: { sceneId: ID, layerId: 'background', from: 1, to: 14 }, frame: 5, prompt: 'a little lighter', references: [] });
    const again = textOf(await call('next_request'));
    expect(again).toContain('Earlier in this thread:');
    expect(again).toContain('1. The user asked: make the ground a deep blue for the first second');
    expect(again).toContain('Summary: set the ground to #1d3a8a over frames 1 to 14');
    expect(again).toContain('Now, turn 2:');
    expect(again).toContain('Prompt: a little lighter');
    json(await call('apply_to_selection', { selection: { sceneId: ID, layerId: 'background', from: 1, to: 14 }, patch: { params: { tone: '#3355aa' } } }));
    const second = json<{ status: string; turns: { status: string }[] }>(await call('complete_request', { id: sent.id, status: 'done', summary: 'lighter' }));
    expect(second).toMatchObject({ status: 'your_turn', turns: [{ status: 'done' }, { status: 'done' }] });

    // Revert to before the first turn puts the scene back byte for byte, and the frames with it.
    await viewerQueue.revertTo(sent.id, 0);
    expect(readFileSync(SCENE_FILE, 'utf8')).toBe(original);
    expect(await imageHash(await render(1))).toBe(before.get(1));
  });

  it('claims a pasted request by id, serves the /next prompt, and reports an empty queue plainly', async () => {
    const pasted = await viewerQueue.create({ selection: { sceneId: ID, layerId: 'pip', from: 0, to: 12 }, frame: 0, prompt: 'wave', references: [] });
    expect(textOf(await call('get_request', { id: pasted.id }))).toContain('Status: working.');
    expect((await viewerQueue.get(pasted.id)).turns[0].checkpointAt).toBeTruthy();
    json(await call('complete_request', { id: pasted.id, status: 'failed', summary: 'could not find a wave pose' }));

    const queued = await viewerQueue.create({ selection: { sceneId: ID, from: 0, to: 4 }, frame: 0, prompt: 'redo these frames', references: ['references/x.png'] });
    const prompt = await client.getPrompt({ name: 'next' });
    const message = prompt.messages[0].content;
    expect(message.type === 'text' && message.text).toContain(`request #${queued.id}`);
    expect(message.type === 'text' && message.text).toContain('all layers (a whole-frame-range selection)');
    expect(message.type === 'text' && message.text).toContain('references/x.png');
    expect(textOf(await call('next_request'))).toMatch(/No Frame Studio request is waiting for an external agent/);
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


describe('projects (M9)', () => {
  const P = ID;
  const scene = (id: string) => `${P}/${id}`;
  const projectFile = join(PROJECT_DIR, 'project.json');
  const shotFile = (id: string) => join(PROJECT_DIR, `${id}.json`);

  it("lists projects with their scenes by qualified id, their cast and their own rigs, and marks those rigs in list_rigs", async () => {
    const projects = json<{ id: string; name: string; main: string; scenes: string[]; rigs: string[]; cast: Record<string, unknown>; errors: string[] }[]>(
      await call('list_projects'),
    );
    const mine = projects.find((p) => p.id === P);
    expect(mine).toMatchObject({ name: "Bears' story", main: scene('film'), rigs: ['iris'], errors: [] });
    expect(mine?.scenes).toEqual(['film', 'meet', 'pip', 'together'].map(scene));
    expect(Object.keys(mine?.cast ?? {})).toEqual(['bruno', 'pip']);
    const scenes = json<{ id: string; project: string | null; layers?: { id: string; scene?: string; cast?: string }[] }[]>(await call('list_scenes'));
    const film = scenes.find((x) => x.id === scene('film'));
    expect(film?.project).toBe(P);
    expect(film?.layers?.find((l) => l.id === 'pip')).toEqual({ id: 'pip', scene: scene('pip') });
    expect(scenes.find((x) => x.id === scene('meet'))?.layers?.find((l) => l.id === 'bruno')).toEqual({ id: 'bruno', cast: 'bruno' });
    const rigs = json<{ id: string; project?: string }[]>(await call('list_rigs'));
    expect(rigs.filter((r) => r.id === 'iris').map((r) => r.project).sort()).toEqual(['bears-story', P].sort());
    expect(rigs.find((r) => r.id === 'bear')?.project).toBeUndefined();
    const got = json<{ file: string; project: { main: string } }>(await call('get_project', { id: P }));
    expect(got).toMatchObject({ file: `projects/${P}/project.json`, project: { main: 'film' } });
  });

  it('takes qualified ids in every scene tool, and writes outputs under the project', async () => {
    const frame = await call('render_frame', { sceneId: scene('film'), frame: 50, maxWidth: 480 });
    expect(textOf(frame)).toContain(`out/${P}/film/frame-00050.png`);
    const hit = json<{ layerId: string }>(await call('hit_test', { sceneId: scene('film'), frame: 50, x: 960, y: 900 }));
    expect(hit.layerId).toBe('pip');
    const edit = json<{ file: string }>(
      await call('apply_to_selection', { selection: { sceneId: scene('film'), layerId: 'pip', from: 40, to: 44 }, patch: { params: { x: 40 } } }),
    );
    expect(edit.file).toBe(`projects/${P}/film.json`);
    expect(JSON.parse(readFileSync(shotFile('film'), 'utf8')).layers[1].overrides).toEqual([{ from: 40, to: 44, params: { x: 40 } }]);
    const html = json<{ file: string; rigs: string[] }>(await call('export', { sceneId: scene('film'), target: 'html' }));
    expect(html.file).toBe(`out/${P}/film/film.html`);
    expect(html.rigs).toContain('iris');
    const bad = await call('update_scene', { id: scene('meet'), patch: { layers: [{ id: 'x', cast: 'nobody' }] } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/no cast member "nobody"/);
    const loop = await call('update_scene', { id: scene('meet'), patch: { layers: [{ id: 'f', scene: 'film' }] } });
    expect(textOf(loop)).toMatch(/in a loop/);
    // Shortening a shot the film trims at 3 s would break the film, so the shot's edit is refused.
    const shorter = await call('update_scene', { id: scene('meet'), patch: { duration: 2.5 } });
    expect(textOf(shorter)).toMatch(/would break scenes in the project[\s\S]*film\.json: /);
    expect(JSON.parse(readFileSync(shotFile('meet'), 'utf8')).duration).toBe(4);
  });

  it('changes the cast in every shot with update_project, and refuses a patch that would break a scene', async () => {
    const before = await imageHash(await call('render_frame', { sceneId: scene('meet'), frame: 24, maxWidth: 480 }));
    const saved = await call('update_project', { id: P, patch: { cast: { bruno: { params: { body: '#c9a27e' } } } } });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).cast.bruno.params.body).toBe('#c9a27e');
    expect(await imageHash(await call('render_frame', { sceneId: scene('meet'), frame: 24, maxWidth: 480 }))).not.toBe(before);

    const text = readFileSync(projectFile, 'utf8');
    const invalid = await call('update_project', { id: P, patch: { fps: 0 } });
    expect(textOf(invalid)).toMatch(/would break the project, so nothing was saved:\n.*project\.json.*fps/);
    const breaking = await call('update_project', { id: P, patch: { cast: { pip: null } } });
    expect(textOf(breaking)).toMatch(/would break the project[\s\S]*pip\.json: [^\n]*no cast member "pip"/);
    expect(readFileSync(projectFile, 'utf8')).toBe(text);
  });

  it("waits to change project.json while another agent's request in the project works, then goes ahead", async () => {
    const queue = new StudioQueue(STUDIO, async (id) => (id.startsWith(`${P}/`) ? shotFile(id.slice(P.length + 1)) : SCENE_FILE));
    const { id } = await queue.create({ selection: { sceneId: scene('pip'), from: 0, to: 12 }, frame: 0, prompt: 'make pip wave sooner', references: [] });
    expect((await queue.claim(id, 'someone-else')).status).toBe('working');
    const started = Date.now();
    const update = call('update_project', { id: P, patch: { cast: { pip: { params: { tonal: 0.3 } } } } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).cast.pip.params.tonal).not.toBe(0.3);
    await queue.complete(id, 'done', 'waved sooner');
    const result = await update;
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).cast.pip.params.tonal).toBe(0.3);
  });
});
