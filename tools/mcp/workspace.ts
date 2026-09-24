// What the MCP tools do, apart from the protocol. One Vite server watches src/
// and scenes/ for the whole session. Scene reads and writes go through the
// viewer's own library code, loaded through that server, and every write is
// validated first. The headless studio (render.html in Playwright) starts on
// the first tool that needs pixels. It reloads whenever a scene or source file
// has changed since it last loaded, so edits an agent makes to files directly
// show up too.

import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Params, Rig, Scene } from '../../src/engine/types.ts';
import type { SceneLibrary } from '../../src/viewer/library.ts';
import type { ContactSheetResult, RenderExportResult, RenderHit } from '../../src/viewer/render-api.ts';
import { buildEmbed } from '../bundle/embed.ts';
import { openStudio, startVite, writeViaSink, type Studio } from '../render/studio.ts';
import { entryPath, loadModules, ROOT, SCENES_DIR, sceneLibrary, writeFileAtomic, type LoadedModules } from '../scene-files.ts';
import { describeTarget, type StudioRequest } from '../../src/studio/protocol.ts';
import { STUDIO_DIR } from '../studio/plugin.ts';
import { StudioQueue } from '../studio/queue.ts';

/** A frame number, or an MM:SS:FF timecode string. */
export type FrameInput = number | string;

export interface SelectionInput {
  sceneId: string;
  layerId?: string;
  partId?: string;
  from: FrameInput;
  to: FrameInput;
}

export interface RigInfo {
  id: string;
  description?: string;
  /** The base rig of a variant, or null for a base rig. */
  base: string | null;
  variants: string[];
  parts: string[];
  params: Rig['params'];
}

export type ExportTarget = 'mp4' | 'gif' | 'html';

const show = (path: string) => relative(ROOT, path);
const pad = (n: number) => String(n).padStart(5, '0');

export class Workspace {
  private studio: Studio | null = null;
  private studioScene: string | null = null;
  /** Bumped on every change under src/ or scenes/; the studio reloads when it moves. */
  private generation = 0;
  private loadedGeneration = -1;
  /** Each scene file's mtime and size when last seen, so an edit is caught even before the watcher reports it. */
  private readonly stamps = new Map<string, string>();

  private readonly vite: ViteDevServer;
  /** The viewer's request queue (ADR 0003). */
  readonly queue: StudioQueue;
  /** Names this agent session in claims. */
  readonly session = `mcp-${process.pid}`;

  private constructor(vite: ViteDevServer) {
    this.vite = vite;
    this.queue = new StudioQueue(STUDIO_DIR, async (sceneId) => entryPath((await this.entry(sceneId)).entry));
    vite.watcher.on('all', (_event, path) => {
      if (path.startsWith(join(ROOT, 'src')) || path.startsWith(SCENES_DIR)) this.generation++;
    });
  }

  static async open(): Promise<Workspace> {
    return new Workspace(await startVite({ watch: true }));
  }

  async close(): Promise<void> {
    await this.studio?.close();
    await this.vite.close();
  }

  private modules(): Promise<LoadedModules> {
    return loadModules(this.vite);
  }

  /** The library as the viewer would build it from disk right now. */
  private async library(): Promise<{ modules: LoadedModules; lib: SceneLibrary }> {
    const modules = await this.modules();
    return { modules, lib: await sceneLibrary(modules) };
  }

  private async entry(key: string) {
    const { modules, lib } = await this.library();
    const entry = modules.library.findEntry(lib, key);
    if (!entry) throw new Error(`No scene "${key}". Scenes: ${lib.entries.map((e) => e.key).join(', ')}`);
    return { modules, lib, entry };
  }

  /** A valid scene by key, or an error listing what is wrong with it. */
  private async validScene(key: string): Promise<{ modules: LoadedModules; scene: Scene; file: string }> {
    const { modules, lib, entry } = await this.entry(key);
    const problems = [...lib.errors, ...entry.errors];
    if (!entry.scene || problems.length > 0) throw new Error(`${entry.file} has errors:\n${problems.join('\n')}`);
    return { modules, scene: entry.scene, file: entryPath(entry) };
  }

  /** The render page on `key`, freshly loaded if anything changed since it last loaded. */
  /** The render page on `key`, whose file is `file`, freshly loaded if anything changed since it last loaded. */
  private async page(key: string, file: string): Promise<Studio> {
    const info = await stat(file);
    const stamp = `${info.mtimeMs}:${info.size}`;
    const seen = this.stamps.get(file);
    this.stamps.set(file, stamp);
    if (seen !== undefined && seen !== stamp) {
      // Changed on disk, maybe by the viewer's Revert, and the watcher may not have said so yet.
      this.vite.moduleGraph.invalidateAll();
      this.generation++;
    }
    const generation = this.generation;
    if (!this.studio) {
      this.studio = await openStudio(key, { server: this.vite });
    } else if (this.studioScene !== key || this.loadedGeneration !== generation) {
      // The page may have navigated before a failed load, so forget what it held until a load succeeds.
      this.studioScene = null;
      await this.studio.load(key);
    }
    this.studioScene = key;
    this.loadedGeneration = generation;
    return this.studio;
  }

  /** Writes a scene file whole, then makes sure nothing serves the old one. */
  private async writeScene(path: string, json: unknown, modules: LoadedModules): Promise<void> {
    await writeFileAtomic(path, modules.engine.formatSceneJson(json));
    this.vite.moduleGraph.invalidateAll();
    this.generation++;
  }

  /** A [from, to) range read with the viewer's own frame-text and range rules, as the render page reads them. */
  private toRange(from: FrameInput, to: FrameInput, scene: Scene, modules: LoadedModules): { from: number; to: number } {
    const read = (value: FrameInput, name: string) => {
      if (typeof value === 'number') return value;
      const parsed = modules.selection.parseFrameText(value, scene.fps);
      if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
      return parsed.frame;
    };
    const range = { from: read(from, 'from'), to: read(to, 'to') };
    const problem = modules.selection.rangeError(range.from, range.to, modules.engine.frameCount(scene));
    if (problem) throw new RangeError(`${problem} (scene "${scene.id}")`);
    return range;
  }

  async listScenes() {
    const { modules, lib } = await this.library();
    return lib.entries.map((e) => ({
      id: e.key,
      file: e.file,
      ...(e.scene
        ? {
            fps: e.scene.fps,
            duration: e.scene.duration,
            frameCount: modules.engine.frameCount(e.scene),
            size: e.scene.size,
            layers: modules.engine.sceneLayers(e.scene).map((l) => ({ id: l.id, rig: l.rig })),
          }
        : {}),
      errors: [...lib.errors, ...e.errors],
    }));
  }

  async getScene(key: string): Promise<{ file: string; scene: unknown; errors: readonly string[] }> {
    const { entry } = await this.entry(key);
    return { file: entry.file, scene: JSON.parse(await readFile(entryPath(entry), 'utf8')), errors: entry.errors };
  }

  async updateScene(key: string, patch: unknown): Promise<{ file: string; scene: unknown }> {
    const { modules, entry } = await this.entry(key);
    const path = entryPath(entry);
    const current = JSON.parse(await readFile(path, 'utf8')) as { id?: unknown };
    const next = modules.engine.mergePatch(current, patch) as { id?: unknown };
    if (next?.id !== current.id) throw new Error(`update_scene cannot change a scene's id ("${String(current.id)}"); its file is named after it`);
    const result = modules.engine.validateScene(next, modules.createRegistry());
    if (!result.ok) throw new Error(`The patched scene is invalid, so nothing was saved:\n${result.errors.join('\n')}`);
    await this.writeScene(path, next, modules);
    return { file: show(path), scene: next };
  }

  async listRigs(): Promise<RigInfo[]> {
    const modules = await this.modules();
    const registry = modules.createRegistry();
    return [...registry.values()].map((rig) => {
      const base = modules.engine.baseRigId(rig.id);
      return {
        id: rig.id,
        ...(rig.description ? { description: rig.description } : {}),
        base: base === rig.id ? null : base,
        variants: modules.engine.variantsOf(registry, rig.id).map((v) => v.id),
        parts: [...(rig.parts ?? [])],
        params: rig.params,
      };
    });
  }

  private async resolveFrame(studio: Studio, value: FrameInput, end = false): Promise<number> {
    return studio.call('resolveFrame', String(value), end);
  }

  /** Renders a frame: the full-size PNG goes to out/, and a preview at most maxWidth wide comes back. */
  async renderFrame(key: string, frame: FrameInput, maxWidth: number): Promise<{ file: string; frame: number; png: Buffer; width: number; height: number }> {
    const { file } = await this.validScene(key);
    const studio = await this.page(key, file);
    const n = await this.resolveFrame(studio, frame);
    const { width, height } = studio.scene;
    const path = join(ROOT, `out/${studio.scene.id}/frame-${pad(n)}.png`);
    await writeViaSink(studio, path, (sink) => studio.call('writePng', n, sink));
    if (maxWidth >= width) return { file: show(path), frame: n, png: await readFile(path), width, height };
    // Only a scaled preview needs a second pass.
    const preview = join(tmpdir(), `frame-studio-preview-${process.pid}-${n}.png`);
    try {
      await writeViaSink(studio, preview, (sink) => studio.call('writePng', n, sink, { maxWidth }));
      const scale = maxWidth / width;
      return { file: show(path), frame: n, png: await readFile(preview), width: Math.round(width * scale), height: Math.round(height * scale) };
    } finally {
      await rm(preview, { force: true });
    }
  }

  async contactSheet(
    key: string,
    options: { from?: FrameInput; to?: FrameInput; every?: number; columns?: number },
  ): Promise<{ file: string; png: Buffer; sheet: ContactSheetResult }> {
    const { file } = await this.validScene(key);
    const studio = await this.page(key, file);
    const from = options.from === undefined ? undefined : await this.resolveFrame(studio, options.from);
    const to = options.to === undefined ? undefined : await this.resolveFrame(studio, options.to, true);
    const id = studio.scene.id;
    const path = join(ROOT, `out/${id}/contact-sheet-${pad(from ?? 0)}-${pad(to ?? studio.scene.frameCount)}${options.every ? `-every${options.every}` : ''}.png`);
    const sheet = await writeViaSink(studio, path, (sink) => studio.call('contactSheet', sink, { from, to, every: options.every, columns: options.columns }));
    return { file: show(path), png: await readFile(path), sheet };
  }

  async hitTest(key: string, frame: FrameInput, x: number, y: number): Promise<RenderHit & { frame: number }> {
    const { file } = await this.validScene(key);
    const studio = await this.page(key, file);
    const n = await this.resolveFrame(studio, frame);
    return { frame: n, ...(await studio.call('hitTest', n, x, y, { parts: true })) };
  }

  /**
   * A scoped edit, written as overrides. With a layerId it edits that layer.
   * Without one, the selection is the whole frame range: params go to every
   * layer whose rig takes all of them, and a rig swap needs a layer.
   */
  async applyToSelection(selection: SelectionInput, patch: { rig?: string; params?: Params }) {
    const { modules, scene, file } = await this.validScene(selection.sceneId);
    const { from, to } = this.toRange(selection.from, selection.to, scene, modules);
    const layers = modules.engine.sceneLayers(scene);
    let targets: string[];
    if (selection.layerId !== undefined) {
      targets = [selection.layerId];
    } else {
      if (patch.rig !== undefined) throw new Error('a rig swap needs a layerId; without one the selection covers every layer');
      const names = Object.keys(patch.params ?? {});
      const registry = modules.createRegistry();
      targets = layers.filter((l) => names.every((name) => name in (registry.get(l.rig)?.params ?? {}))).map((l) => l.id);
      if (targets.length === 0) throw new Error(`no layer's rig takes all of ${names.join(', ')}; give a layerId, or params one rig takes`);
    }
    let edited = scene;
    for (const layerId of targets) edited = modules.engine.applyToSelection(edited, { layerId, partId: selection.partId, from, to }, patch);

    // Write the edit into the file as written, not the validated copy, so fields the validator fills in stay out of it.
    const raw = JSON.parse(await readFile(file, 'utf8')) as Scene;
    const layerIn = (s: Scene, id: string) => (id === 'background' ? s.background : s.layers.find((l) => l.id === id));
    for (const layerId of targets) {
      const target = layerIn(raw, layerId);
      if (!target) throw new Error(`no layer "${layerId}" in ${show(file)}`);
      target.overrides = layerIn(edited, layerId)?.overrides;
    }
    const result = modules.engine.validateScene(raw, modules.createRegistry());
    if (!result.ok) throw new Error(`That edit would make the scene invalid, so nothing was saved:\n${result.errors.join('\n')}`);
    await this.writeScene(file, raw, modules);
    return {
      file: show(file),
      from,
      to,
      layers: targets.map((layerId) => ({ layerId, overrides: layerIn(raw, layerId)?.overrides })),
      ...(selection.partId !== undefined
        ? { note: `partId "${selection.partId}" noted, but params apply to the whole layer; part-level edits need a rig variant` }
        : {}),
    };
  }

  async export(key: string, target: ExportTarget, range: { from?: FrameInput; to?: FrameInput } = {}): Promise<{ file: string } & Partial<RenderExportResult> & { bytes?: number; rigs?: string[] }> {
    const { scene, file } = await this.validScene(key);
    if (target === 'html') {
      if (range.from !== undefined || range.to !== undefined) throw new Error('html exports the whole scene; leave out from and to');
      const embed = await buildEmbed(key, { server: this.vite });
      const path = join(ROOT, `out/${scene.id}/${scene.id}.html`);
      await writeFileAtomic(path, embed.html);
      return { file: show(path), bytes: embed.bytes.total, rigs: embed.rigs };
    }
    const studio = await this.page(key, file);
    const from = range.from === undefined ? undefined : await this.resolveFrame(studio, range.from);
    const to = range.to === undefined ? undefined : await this.resolveFrame(studio, range.to, true);
    const suffix = from !== undefined || to !== undefined ? `-${pad(from ?? 0)}-${pad(to ?? studio.scene.frameCount)}` : '';
    const path = join(ROOT, `out/${scene.id}/${scene.id}${suffix}.${target}`);
    const result = await writeViaSink(studio, path, (sink) => studio.call('exportVideo', target, sink, { from, to }));
    return { file: show(path), ...result };
  }

  /** Claims the oldest pending request for this session; null when none is pending. */
  nextRequest(): Promise<StudioRequest | null> {
    return this.queue.claimNext(this.session);
  }

  /** A request by id, claimed for this session if it is still pending, so its checkpoint is taken. */
  getRequest(id: number): Promise<StudioRequest> {
    return this.queue.claim(id, this.session);
  }

  completeRequest(id: number, status: 'done' | 'failed', summary: string): Promise<StudioRequest> {
    return this.queue.complete(id, status, summary);
  }

  /** A request described for the agent: what was asked, what is selected, and how to finish. */
  async describeRequest(request: StudioRequest): Promise<string> {
    const s = request.selection;
    let file = '';
    let range = `frames [${s.from}, ${s.to})`;
    try {
      const { modules, entry } = await this.entry(s.sceneId);
      file = ` (${entry.file})`;
      if (entry.scene) range += ` (${modules.engine.formatTimecode(s.from, entry.scene.fps)} to ${modules.engine.formatTimecode(s.to, entry.scene.fps)})`;
    } catch {
      // The scene may have been renamed; the id still says which one.
    }
    const target = `${describeTarget(s)}${s.layerId === undefined ? ' (a whole-frame-range selection)' : ''}`;
    const attempt = request.attempt && request.attempt > 1 ? ` (attempt ${request.attempt} of #${request.retryOf}; the user reverted the earlier attempt and asked again)` : '';
    const lines = [
      `Frame Studio request #${request.id}${attempt}. Status: ${request.status.replace('_', ' ')}.`,
      `Prompt: ${request.prompt}`,
      `Scene: ${s.sceneId}${file}`,
      `Selection: ${target}, ${range}`,
      `Frame on screen when sent: ${request.frame}${request.point ? `; the user clicked scene pixel (${Math.round(request.point.x)}, ${Math.round(request.point.y)})` : ''}`,
      ...(request.references.length > 0 ? [`Reference images (open them to see what the user means; never put them in a scene or export): ${request.references.join(', ')}`] : []),
      ...(request.checkpoint ? ['The scene was saved before you start, so the user can revert your change.'] : []),
      '',
      'How to do it: look with render_frame, render_contact_sheet and hit_test. Change it with apply_to_selection (pass this selection), update_scene, or a new rig variant under src/rigs applied through an override. Render again to check.',
      `When you finish, call complete_request with id ${request.id}, status "done" or "failed", and a one-line summary of what you changed or why it failed.`,
    ];
    return lines.join('\n');
  }
}
