// What the MCP tools do, apart from the protocol. The workspace lives in the
// studio server (ADR 0008) and works on its studio folder. Scene reads and
// writes go through the viewer's own library code, with the rigs and
// generators the server's code host loaded, and every write is validated
// first. Pixels come from the server's render worker, which loads the library
// again whenever files changed, so edits an agent makes to files directly show
// up too.

import { randomInt } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Layer, Params, Rig, RigRegistry, Scene } from '../../src/engine/types.ts';
import type { SceneEntry, SceneLibrary } from '../../src/viewer/library.ts';
import type { ContactSheetResult, RenderExportResult, RenderHit } from '../../src/viewer/render-api.ts';
import { buildEmbed } from '../bundle/embed.ts';
import { openStudio, poolTransport, writeViaSink, type Studio } from '../render/studio.ts';
import { entryPath, libraryFrom, loadModules, readSceneFiles, sceneLibrary, writeFileAtomic, type LoadedModules } from '../scene-files.ts';
import type { CodeHost } from '../studio/code.ts';
import type { StudioFolder } from '../studio/folder.ts';
import type { RenderPool } from '../studio/render-pool.ts';
import { checkNewComposition, checkNewScene, DEFAULT_FORMAT, projectOf, type NewComposition, type NewScene, type StudioRequest } from '../../src/studio/protocol.ts';
import { describeThread, type SceneInfo } from '../studio/describe.ts';
import { importMedia, mediaInfo, type MediaInfo } from '../studio/media.ts';
import type { StudioQueue } from '../studio/queue.ts';

/** What the workspace works with: the studio server's folder, code, render worker and queue. */
export interface WorkspaceContext {
  folder: StudioFolder;
  code: CodeHost;
  pool: RenderPool;
  queue: StudioQueue;
  /** Bumps the server's file generation after a write, so the render worker loads the library again. */
  touch(): number;
  generation(): number;
}

/** A frame number, or an MM:SS:FF timecode string. */
export type FrameInput = number | string;

/** Who is calling a tool: an agent in the studio names its thread; an external agent, its session. */
export interface Caller {
  thread?: number;
  session?: string;
}

export interface SelectionInput {
  sceneId: string;
  layerId?: string;
  partId?: string;
  from: FrameInput;
  to: FrameInput;
}

export interface RigInfo {
  id: string;
  /** Set for a project's own rig: only that project's scenes can draw with it. */
  project?: string;
  description?: string;
  /** The base rig of a variant, or null for a base rig. */
  base: string | null;
  variants: string[];
  parts: string[];
  params: Rig['params'];
}

export interface GeneratorInfo {
  id: string;
  description?: string;
  params: Rig['params'];
}

export type ExportTarget = 'mp4' | 'gif' | 'html';

const pad = (n: number) => String(n).padStart(5, '0');

export class Workspace {
  private studio: Studio | null = null;
  private studioScene: string | null = null;
  private loadedGeneration = -1;
  /** The mtimes and sizes of each scene's files when last seen, by scene key, so an edit is caught even before the watcher reports it. */
  private readonly stamps = new Map<string, string>();
  private readonly ctx: WorkspaceContext;
  private readonly folder: StudioFolder;
  /** The viewer's request queue (ADR 0003). */
  readonly queue: StudioQueue;
  /** Names an external agent's claims when its connection doesn't say which session it is. */
  readonly session = `mcp-${process.pid}`;

  constructor(ctx: WorkspaceContext) {
    this.ctx = ctx;
    this.folder = ctx.folder;
    this.queue = ctx.queue;
  }

  async close(): Promise<void> {
    await this.studio?.close();
  }

  /** A path as the tools show it: relative to the studio folder. */
  private show(path: string): string {
    return relative(this.folder.root, path);
  }

  private modules(): Promise<LoadedModules> {
    return loadModules(this.ctx.code);
  }

  /** The library as the viewer would build it from disk right now. */
  private async library(): Promise<{ modules: LoadedModules; lib: SceneLibrary }> {
    const modules = await this.modules();
    return { modules, lib: await sceneLibrary(modules, this.folder) };
  }

  private async entry(key: string) {
    const { modules, lib } = await this.library();
    const entry = modules.library.findEntry(lib, key);
    if (!entry) throw new Error(`No scene "${key}". Scenes: ${lib.entries.map((e) => e.key).join(', ')}`);
    return { modules, lib, entry };
  }

  /**
   * A valid scene by key, or an error listing what is wrong with it. `files` are what its pixels depend on:
   * its own file, and for a project scene every file of the project.
   */
  private async validScene(key: string): Promise<{ modules: LoadedModules; scene: Scene; file: string; entry: SceneEntry; files: string[] }> {
    const { modules, lib, entry } = await this.entry(key);
    const project = entry.project !== null ? lib.projects.find((p) => p.id === entry.project) : undefined;
    const problems = [...lib.errors, ...entry.errors, ...(project?.errors ?? []).map((e) => `${project!.file}: ${e}`)];
    if (!entry.scene || problems.length > 0) throw new Error(`${entry.file} has errors:\n${problems.join('\n')}`);
    const file = entryPath(entry, this.folder);
    const files = project
      ? [join(this.folder.projects, project.id, 'project.json'), ...lib.entries.filter((e) => e.project === project.id).map((e) => entryPath(e, this.folder))]
      : [file];
    return { modules, scene: entry.scene, file, entry, files };
  }

  /**
   * What would go wrong in project `project` if the file at module path `path` ("/projects/<id>/<file>.json")
   * held `json`: the project rebuilt as the viewer would build it. Every error of that file, and of every
   * other file of the project that is fine now, each "file: message". Empty when nothing breaks.
   */
  private async projectBreaks(modules: LoadedModules, lib: SceneLibrary, project: string, path: string, json: unknown): Promise<string[]> {
    const prefix = `/projects/${project}/`;
    const files = Object.fromEntries(Object.entries(await readSceneFiles(this.folder)).filter(([k]) => k.startsWith(prefix)));
    files[path] = JSON.stringify(json);
    const after = await libraryFrom(modules, files);
    const errors: string[] = [];
    const before = lib.projects.find((p) => p.id === project);
    const now = after.projects.find((p) => p.id === project);
    if (now && now.errors.length > 0 && (path.endsWith('/project.json') || (before?.errors.length ?? 0) === 0)) {
      errors.push(...now.errors.map((e) => `${now.file}: ${e}`));
    }
    for (const e of after.entries) {
      const wasFine = lib.entries.find((b) => b.key === e.key)?.scene != null;
      if (e.errors.length > 0 && (e.path === path || wasFine)) errors.push(...e.errors.map((x) => `${e.file}: ${x}`));
    }
    return errors;
  }

  /**
   * Checks an edited scene the way the viewer will: against its rigs, and for a project scene against its
   * project and every scene that places it, however deep. Throws with every problem.
   */
  private async checkEdit(modules: LoadedModules, entry: SceneEntry, scene: unknown, action: string): Promise<void> {
    await this.checkMedia(scene, action);
    if (entry.project !== null) {
      const broken = await this.projectBreaks(modules, (await this.library()).lib, entry.project, entry.path, scene);
      if (broken.length > 0) throw new Error(`${action} would break scenes in the project, so nothing was saved:\n${broken.join('\n')}`);
      return;
    }
    // A folder's scene or composition (ADR 0013): checked as the viewer will build it, with the compositions that place it.
    const { lib } = await this.library();
    const broken = await this.folderBreaks(modules, lib, entry.path, scene);
    const own = broken.filter((b) => b.startsWith(`${entry.file}: `)).map((b) => b.slice(entry.file.length + 2));
    const others = broken.filter((b) => !b.startsWith(`${entry.file}: `));
    if (own.length > 0) throw new Error(`${action} would make the ${entry.kind} invalid, so nothing was saved:\n${own.join('\n')}`);
    if (others.length > 0) throw new Error(`${action} would break the compositions that place it, so nothing was saved:\n${others.join('\n')}`);
  }

  /**
   * What would go wrong in the folder's own scenes and compositions (ADR 0013) if the file at module path
   * `path` held `json`: every error of that file, and of any other that is fine now, each "file: message".
   */
  private async folderBreaks(modules: LoadedModules, lib: SceneLibrary, path: string, json: unknown): Promise<string[]> {
    const files = await readSceneFiles(this.folder);
    files[path] = JSON.stringify(json);
    const after = await libraryFrom(modules, files);
    const errors: string[] = [];
    if (path === '/project.json' && after.folder && after.folder.errors.length > 0) errors.push(...after.folder.errors.map((e) => `project.json: ${e}`));
    for (const e of after.entries) {
      if (e.project !== null) continue;
      const wasFine = lib.entries.find((b) => b.key === e.key)?.scene != null;
      if (e.errors.length > 0 && (e.path === path || wasFine)) errors.push(...e.errors.map((x) => `${e.file}: ${x}`));
    }
    return errors;
  }

  /** Refuses a scene whose sound file cues name files that aren't in media/ (ADR 0012). */
  private async checkMedia(scene: unknown, action: string): Promise<void> {
    const cues = (scene as { audio?: unknown } | null)?.audio;
    if (!Array.isArray(cues)) return;
    const files = cues.flatMap((c) => (typeof (c as { file?: unknown })?.file === 'string' ? [(c as { file: string }).file] : []));
    if (files.length === 0) return;
    const have = new Set((await mediaInfo(this.folder)).map((m) => m.file));
    const missing = [...new Set(files.filter((f) => !have.has(f)))];
    if (missing.length > 0) {
      throw new Error(`${action} plays ${missing.join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} in media/, so nothing was saved. list_media shows the files; import_media copies one in.`);
    }
  }

  /**
   * Adds a cue that plays sound file `file` in scene `key` from `start` seconds, snapped to its frame, to the
   * end of the file or the scene, whichever is first (ADR 0012). Refused while an agent works on the scene.
   */
  async placeSound(key: string, file: string, start: number): Promise<{ file: string; cue: Record<string, unknown> }> {
    const { modules, entry } = await this.entry(key);
    const working = (await this.queue.list()).find((r) => r.status === 'working' && r.sceneId === entry.key);
    if (working) throw new Error(`Request #${working.id} is working on this scene; place the sound when its turn ends.`);
    const info = (await mediaInfo(this.folder)).find((m) => m.file === file);
    if (!info) throw new Error(`No sound file "${file}" in media/.`);
    const path = entryPath(entry, this.folder);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { fps: number; duration: number; audio?: { id: string }[] };
    const frame = Math.min(Math.max(0, Math.floor(start * raw.fps)), Math.max(0, modules.engine.frameCount(raw as Scene) - 1));
    const from = frame / raw.fps;
    const end = Math.min(raw.duration, info.duration !== undefined ? from + info.duration : raw.duration);
    const taken = new Set((raw.audio ?? []).map((c) => c.id));
    const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sound';
    let id = stem;
    for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
    const cue = { id, file, start: Math.round(from * 1e6) / 1e6, end: Math.round(end * 1e6) / 1e6 };
    const next = { ...raw, audio: [...(raw.audio ?? []), cue] };
    await this.checkEdit(modules, entry, next, 'Placing the sound');
    await this.writeScene(path, next, modules);
    return { file: this.show(path), cue };
  }

  /** The studio folder's sound files, with their lengths (ADR 0012). */
  listMedia(): Promise<MediaInfo[]> {
    return mediaInfo(this.folder);
  }

  /** Copies a sound file from disk into media/, and returns it with its length. */
  async importMedia(source: string): Promise<MediaInfo> {
    const file = await importMedia(this.folder, source);
    this.ctx.touch();
    return (await mediaInfo(this.folder)).find((m) => m.file === file) ?? { file, bytes: 0, modified: 0 };
  }

  /** The render page on `key`, whose pixels depend on `files`, freshly loaded if anything changed since it last loaded. */
  private async page(key: string, files: string[]): Promise<Studio> {
    const stamps: string[] = [];
    for (const file of files) {
      const info = await stat(file).catch(() => null);
      stamps.push(info ? `${file}:${info.mtimeMs}:${info.size}` : `${file}:gone`);
    }
    const stamp = stamps.join('|');
    const seen = this.stamps.get(key);
    this.stamps.set(key, stamp);
    // Changed on disk, maybe by the viewer's Revert, and the watcher may not have said so yet.
    if (seen !== undefined && seen !== stamp) this.ctx.touch();
    const generation = this.ctx.generation();
    if (!this.studio) {
      this.studio = await openStudio(key, { transport: poolTransport(this.ctx.pool) });
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
    this.ctx.touch();
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

  /** Loose scenes first, then each project's, with their project; ids are qualified in projects (ADR 0007). */
  async listScenes() {
    const { modules, lib } = await this.library();
    return lib.entries.map((e) => ({
      id: e.key,
      kind: e.kind,
      project: e.project,
      file: e.file,
      ...(e.scene
        ? {
            fps: e.scene.fps,
            duration: e.scene.duration,
            frameCount: modules.engine.frameCount(e.scene),
            size: e.scene.size,
            layers: modules.engine.sceneLayers(e.scene).map((l) => ({
              id: l.id,
              ...(l.rig !== undefined ? { rig: l.rig } : {}),
              ...(l.cast !== undefined ? { cast: l.cast } : {}),
              ...(l.scene !== undefined ? { scene: e.project !== null ? `${e.project}/${l.scene}` : l.scene } : {}),
            })),
          }
        : {}),
      errors: [...lib.errors, ...e.errors],
    }));
  }

  /** Every project: its settings, scenes by qualified id, own rigs, and any errors in project.json. */
  async listProjects() {
    const { lib } = await this.library();
    const rigs = await (await this.modules()).projectRigs();
    return lib.projects.map((p) => ({
      id: p.id,
      name: p.name,
      file: p.file,
      ...(p.project ? { fps: p.project.fps, size: p.project.size, main: p.main, cast: p.project.cast ?? {} } : {}),
      scenes: lib.entries.filter((e) => e.project === p.id).map((e) => e.key),
      rigs: (rigs[p.id] ?? []).map((r) => r.id),
      errors: p.errors,
    }));
  }

  private async project(id: string) {
    const { modules, lib } = await this.library();
    const project = lib.projects.find((p) => p.id === id);
    if (!project) throw new Error(`No project "${id}". Projects: ${lib.projects.map((p) => p.id).join(', ') || 'none yet'}`);
    return { modules, lib, project, path: join(this.folder.projects, id, 'project.json') };
  }

  /** project.json exactly as it is in its file, plus the project's scenes and any errors. */
  async getProject(id: string): Promise<{ file: string; project: unknown; scenes: string[]; errors: readonly string[] }> {
    const { lib, project, path } = await this.project(id);
    return {
      file: project.file,
      project: JSON.parse(await readFile(path, 'utf8')),
      scenes: lib.entries.filter((e) => e.project === id).map((e) => e.key),
      errors: project.errors,
    };
  }

  /**
   * Working threads in the project, except the caller's: its own thread for an agent in the studio, or for an
   * external agent every thread its session has claimed.
   */
  private async projectWork(id: string, caller: Caller = {}): Promise<StudioRequest[]> {
    const working = (await this.queue.list()).filter((r) => r.status === 'working' && projectOf(r.sceneId) === id);
    if (caller.thread !== undefined) return working.filter((r) => r.id !== caller.thread);
    // An external session doesn't say which of its threads a call is for, so it gets a pass only with one.
    const session = caller.session ?? this.session;
    const own = working.filter((r) => r.turns.at(-1)?.claimedBy === session);
    return own.length > 1 ? working : working.filter((r) => !own.includes(r));
  }

  /** Waits until no other thread in the project works, up to `ms`. Runs outside the tool queue, so other calls go on. */
  async waitForProject(id: string, caller: Caller, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while ((await this.projectWork(id, caller)).length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * A merge patch to project.json (ADR 0007). It touches every scene in the project, so it goes ahead only
   * while no other thread there works. The result is checked as a project, and every scene in the project
   * that is valid now must stay valid under it (fps, size, cast).
   */
  async updateProject(id: string, patch: unknown, caller: Caller = {}): Promise<{ file: string; project: unknown }> {
    const { modules, lib, project, path } = await this.project(id);
    const busy = await this.projectWork(id, caller);
    if (busy.length > 0) {
      throw new Error(
        `project.json touches every scene in "${id}", so it can't change while ${busy.map((r) => `request #${r.id} on "${r.sceneId}"`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} working. Try again when that turn ends.`,
      );
    }
    const current = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const next = modules.engine.mergePatch(current, patch);
    const broken = await this.projectBreaks(modules, lib, id, `/projects/${id}/project.json`, next);
    if (broken.length > 0) throw new Error(`That patch would break the project, so nothing was saved:\n${broken.join('\n')}`);
    await this.writeScene(path, next, modules);
    return { file: project.file, project: next };
  }

  async getScene(key: string): Promise<{ file: string; scene: unknown; errors: readonly string[] }> {
    const { entry } = await this.entry(key);
    return { file: entry.file, scene: JSON.parse(await readFile(entryPath(entry, this.folder), 'utf8')), errors: entry.errors };
  }

  async updateScene(key: string, patch: unknown): Promise<{ file: string; scene: unknown }> {
    const { modules, entry } = await this.entry(key);
    const path = entryPath(entry, this.folder);
    const current = JSON.parse(await readFile(path, 'utf8')) as { id?: unknown };
    const next = modules.engine.mergePatch(current, patch) as { id?: unknown };
    if (next?.id !== current.id) throw new Error(`update_scene cannot change a scene's id ("${String(current.id)}"); its file is named after it`);
    await this.checkEdit(modules, entry, next, 'That patch');
    await this.writeScene(path, next, modules);
    return { file: this.show(path), scene: next };
  }

  /** A scene with nothing in it yet: paper, no layers, and a seed of its own. */
  private emptyScene(id: string, fps: number, size: readonly [number, number], duration: number) {
    return { id, fps, duration, size: [size[0], size[1]], seed: randomInt(1, 100_000), background: { rig: 'paper' }, layers: [] };
  }

  /**
   * A new, empty scene: loose in scenes/, or in a project, where it takes the project's fps and size. It
   * refuses an id that is taken, and a scene that wouldn't validate. Returns the scene's id as list_scenes
   * shows it.
   */
  async createScene(input: NewScene): Promise<{ id: string; file: string; scene: unknown }> {
    const problem = checkNewScene(input);
    if (problem) throw new Error(problem);
    const { modules, lib } = await this.library();
    let key: string;
    let path: string;
    let scene: ReturnType<Workspace['emptyScene']>;
    if (input.project !== undefined) {
      const project = lib.projects.find((p) => p.id === input.project);
      if (!project) throw new Error(`No project "${input.project}". Projects: ${lib.projects.map((p) => p.id).join(', ') || 'none yet'}`);
      if (!project.project) throw new Error(`${project.file} has errors, so the project can't take a new scene until they're fixed:\n${project.errors.join('\n')}`);
      key = `${project.id}/${input.id}`;
      path = join(this.folder.projects, project.id, `${input.id}.json`);
      scene = this.emptyScene(input.id, project.project.fps, project.project.size, input.duration);
    } else {
      key = input.id;
      path = join(this.folder.scenes, `${input.id}.json`);
      const format = this.defaultFormat(lib);
      scene = this.emptyScene(input.id, input.fps ?? format.fps, input.size ?? format.size, input.duration);
    }
    if (lib.entries.some((e) => e.key === key) || (await stat(path).catch(() => null))) {
      throw new Error(`There is already a scene "${key}"${input.project === undefined ? ' in scenes/' : ''}. Pick another name.`);
    }
    if (input.project !== undefined) {
      const broken = await this.projectBreaks(modules, lib, input.project, `/projects/${input.project}/${input.id}.json`, scene);
      if (broken.length > 0) throw new Error(`The new scene would break the project, so nothing was saved:\n${broken.join('\n')}`);
    } else {
      const broken = (await this.folderBreaks(modules, lib, `/scenes/${input.id}.json`, scene)).map((e) => e.replace(/^scenes\/[^:]+: /, ''));
      if (broken.length > 0) throw new Error(`The new scene would be invalid, so nothing was saved:\n${broken.join('\n')}`);
    }
    await mkdir(dirname(path), { recursive: true });
    await this.writeScene(path, scene, modules);
    return { id: key, file: this.show(path), scene };
  }

  /** The format a new scene or composition gets: project.json's, else 24 fps at 1920×1080 (ADR 0013). */
  private defaultFormat(lib: SceneLibrary): { fps: number; size: [number, number] } {
    const project = lib.folder?.project;
    return { fps: project?.fps ?? DEFAULT_FORMAT.fps, size: project?.size ?? DEFAULT_FORMAT.size };
  }

  /**
   * A new composition (ADR 0013): compositions/<id>.json with one empty track, the format given or the
   * project's, and a black background. It refuses an id a scene or composition has. Returns its id.
   */
  async createComposition(input: NewComposition): Promise<{ id: string; file: string; composition: unknown }> {
    const problem = checkNewComposition(input);
    if (problem) throw new Error(problem);
    const { modules, lib } = await this.library();
    const path = join(this.folder.compositions, `${input.id}.json`);
    if (lib.entries.some((e) => e.key === input.id) || (await stat(path).catch(() => null))) {
      throw new Error(`There is already a scene or composition "${input.id}". Pick another name.`);
    }
    const format = this.defaultFormat(lib);
    const size = input.size ?? format.size;
    const composition = { id: input.id, fps: input.fps ?? format.fps, duration: input.duration, size: [size[0], size[1]], background: '#000000', tracks: [{ id: 'V1', clips: [] }] };
    const broken = (await this.folderBreaks(modules, lib, `/compositions/${input.id}.json`, composition)).map((e) => e.replace(/^compositions\/[^:]+: /, ''));
    if (broken.length > 0) throw new Error(`The new composition would be invalid, so nothing was saved:\n${broken.join('\n')}`);
    await mkdir(dirname(path), { recursive: true });
    await this.writeScene(path, composition, modules);
    return { id: input.id, file: this.show(path), composition };
  }

  /** The folder's project.json (ADR 0013): its name, default format and cast, or {} when it has none. */
  async getFolderProject(): Promise<{ file: string; project: unknown; errors: readonly string[] }> {
    const { lib } = await this.library();
    const text = await readFile(join(this.folder.root, 'project.json'), 'utf8').catch(() => null);
    return { file: 'project.json', project: text === null ? {} : (JSON.parse(text) as unknown), errors: lib.folder?.errors ?? [] };
  }

  /**
   * A merge patch to the folder's project.json, such as a cast change. The result must be a valid project
   * file, and every scene and composition valid now must stay valid under it.
   */
  async updateFolderProject(patch: unknown): Promise<{ file: string; project: unknown }> {
    const { modules, lib } = await this.library();
    const path = join(this.folder.root, 'project.json');
    const current = JSON.parse((await readFile(path, 'utf8').catch(() => null)) ?? '{}') as unknown;
    const next = modules.engine.mergePatch(current, patch);
    const broken = await this.folderBreaks(modules, lib, '/project.json', next);
    if (broken.length > 0) throw new Error(`That patch would break the project, so nothing was saved:\n${broken.join('\n')}`);
    await this.writeScene(path, next, modules);
    return { file: 'project.json', project: next };
  }

  /** Every rig: the global library, then each project's own, marked with its project (ADR 0007). */
  async listRigs(): Promise<RigInfo[]> {
    const modules = await this.modules();
    const describe = (rig: Rig, registry: RigRegistry, project?: string): RigInfo => {
      const base = modules.engine.baseRigId(rig.id);
      return {
        id: rig.id,
        ...(project ? { project } : {}),
        ...(rig.description ? { description: rig.description } : {}),
        base: base === rig.id ? null : base,
        variants: modules.engine.variantsOf(registry, rig.id).map((v) => v.id),
        parts: [...(rig.parts ?? [])],
        params: rig.params,
      };
    };
    const global = modules.createRegistry();
    const out = [...global.values()].map((rig) => describe(rig, global));
    for (const [project, rigs] of Object.entries(await modules.projectRigs())) {
      let registry: RigRegistry;
      try {
        registry = modules.createProjectRegistry(rigs);
      } catch {
        continue; // list_projects reports a project whose rigs fail to register
      }
      out.push(...rigs.map((rig) => describe(rig, registry, project)));
    }
    return out;
  }

  private async resolveFrame(studio: Studio, value: FrameInput, end = false): Promise<number> {
    return studio.call('resolveFrame', String(value), end);
  }

  /** Renders a frame: the full-size PNG goes to out/, and a preview at most maxWidth wide comes back. */
  async renderFrame(key: string, frame: FrameInput, maxWidth: number): Promise<{ file: string; frame: number; png: Buffer; width: number; height: number }> {
    const { files } = await this.validScene(key);
    const studio = await this.page(key, files);
    const n = await this.resolveFrame(studio, frame);
    const { width, height } = studio.scene;
    const path = join(this.folder.out, studio.scene.out, `frame-${pad(n)}.png`);
    await writeViaSink(studio, path, (sink) => studio.call('writePng', n, sink));
    if (maxWidth >= width) return { file: this.show(path), frame: n, png: await readFile(path), width, height };
    // Only a scaled preview needs a second pass.
    const preview = join(tmpdir(), `frame-studio-preview-${process.pid}-${n}.png`);
    try {
      await writeViaSink(studio, preview, (sink) => studio.call('writePng', n, sink, { maxWidth }));
      const scale = maxWidth / width;
      return { file: this.show(path), frame: n, png: await readFile(preview), width: Math.round(width * scale), height: Math.round(height * scale) };
    } finally {
      await rm(preview, { force: true });
    }
  }

  async contactSheet(
    key: string,
    options: { from?: FrameInput; to?: FrameInput; every?: number; columns?: number },
  ): Promise<{ file: string; png: Buffer; sheet: ContactSheetResult }> {
    const { files } = await this.validScene(key);
    const studio = await this.page(key, files);
    const from = options.from === undefined ? undefined : await this.resolveFrame(studio, options.from);
    const to = options.to === undefined ? undefined : await this.resolveFrame(studio, options.to, true);
    const path = join(this.folder.out, `${studio.scene.out}/contact-sheet-${pad(from ?? 0)}-${pad(to ?? studio.scene.frameCount)}${options.every ? `-every${options.every}` : ''}.png`);
    const sheet = await writeViaSink(studio, path, (sink) => studio.call('contactSheet', sink, { from, to, every: options.every, columns: options.columns }));
    return { file: this.show(path), png: await readFile(path), sheet };
  }

  async hitTest(key: string, frame: FrameInput, x: number, y: number): Promise<RenderHit & { frame: number }> {
    const { files } = await this.validScene(key);
    const studio = await this.page(key, files);
    const n = await this.resolveFrame(studio, frame);
    return { frame: n, ...(await studio.call('hitTest', n, x, y, { parts: true })) };
  }

  /**
   * A scoped edit, written as overrides. With a layerId it edits that layer.
   * Without one, the selection is the whole frame range: params go to every
   * layer whose rig takes all of them, and a rig swap needs a layer.
   */
  async applyToSelection(selection: SelectionInput, patch: { rig?: string; params?: Params }) {
    const { modules, scene, file, entry } = await this.validScene(selection.sceneId);
    const { from, to } = this.toRange(selection.from, selection.to, scene, modules);
    const layers = modules.engine.sceneLayers(scene);
    let targets: string[];
    if (selection.layerId !== undefined) {
      targets = [selection.layerId];
    } else {
      if (patch.rig !== undefined) throw new Error('a rig swap needs a layerId; without one the selection covers every layer');
      const names = Object.keys(patch.params ?? {});
      const registry = entry.registry ?? modules.createRegistry();
      const paramsOf = (l: Layer) =>
        l.scene !== undefined ? modules.engine.SCENE_LAYER_PARAMS : (registry.get(l.rig ?? entry.world.cast?.[l.cast ?? '']?.rig ?? '')?.params ?? {});
      targets = layers.filter((l) => names.every((name) => name in paramsOf(l))).map((l) => l.id);
      if (targets.length === 0) throw new Error(`no layer's rig takes all of ${names.join(', ')}; give a layerId, or params one rig takes`);
    }
    let edited = scene;
    for (const layerId of targets) edited = modules.engine.applyToSelection(edited, { layerId, partId: selection.partId, from, to }, patch);

    // Write the edit into the file as written, not the validated copy, so fields the validator fills in stay out of it.
    const raw = JSON.parse(await readFile(file, 'utf8')) as Scene & { tracks?: { clips: Layer[] }[] };
    // A composition's clips are in its tracks (ADR 0013).
    const layerIn = (s: Scene & { tracks?: { clips: Layer[] }[] }, id: string) =>
      id === 'background' ? s.background : (s.tracks ? s.tracks.flatMap((t) => t.clips) : s.layers).find((l) => l.id === id);
    for (const layerId of targets) {
      const target = layerIn(raw, layerId);
      if (!target) throw new Error(`no layer "${layerId}" in ${this.show(file)}`);
      target.overrides = (layerId === 'background' ? edited.background : edited.layers.find((l) => l.id === layerId))?.overrides;
    }
    await this.checkEdit(modules, entry, raw, 'That edit');
    await this.writeScene(file, raw, modules);
    return {
      file: this.show(file),
      from,
      to,
      layers: targets.map((layerId) => ({ layerId, overrides: layerIn(raw, layerId)?.overrides })),
      ...(selection.partId !== undefined
        ? { note: `partId "${selection.partId}" noted, but params apply to the whole layer; part-level edits need a rig variant` }
        : {}),
    };
  }

  async listGenerators(): Promise<GeneratorInfo[]> {
    const modules = await this.modules();
    return [...modules.createGenerators().values()].map((g) => ({
      id: g.id,
      ...(g.description ? { description: g.description } : {}),
      params: g.params,
    }));
  }

  async export(
    key: string,
    target: ExportTarget,
    options: { from?: FrameInput; to?: FrameInput; silent?: boolean; media?: boolean } = {},
  ): Promise<{ file: string } & Partial<RenderExportResult> & { bytes?: number; rigs?: string[]; generators?: string[]; mediaLeftOut?: string[] }> {
    const { scene, files } = await this.validScene(key);
    if (target === 'html') {
      if (options.from !== undefined || options.to !== undefined) throw new Error('html exports the whole scene; leave out from and to');
      const embed = await buildEmbed(key, { folder: this.folder, code: this.ctx.code, silent: options.silent, media: options.media });
      const path = join(this.folder.out, embed.out, `${scene.id}.html`);
      await writeFileAtomic(path, embed.html);
      return { file: this.show(path), bytes: embed.bytes.total, rigs: embed.rigs, generators: embed.generators, ...(embed.mediaLeftOut.length > 0 ? { mediaLeftOut: embed.mediaLeftOut } : {}) };
    }
    if (target === 'gif' && options.silent !== undefined) throw new Error('gif is always silent; leave out silent');
    const studio = await this.page(key, files);
    const from = options.from === undefined ? undefined : await this.resolveFrame(studio, options.from);
    const to = options.to === undefined ? undefined : await this.resolveFrame(studio, options.to, true);
    const suffix = from !== undefined || to !== undefined ? `-${pad(from ?? 0)}-${pad(to ?? studio.scene.frameCount)}` : '';
    const path = join(this.folder.out, studio.scene.out, `${scene.id}${suffix}.${target}`);
    const result = await writeViaSink(studio, path, (sink) => studio.call('exportVideo', target, sink, { from, to, silent: options.silent }));
    return { file: this.show(path), ...result };
  }

  /** Claims the oldest thread waiting for an external agent, for `session`; null when none is waiting. */
  nextRequest(session = this.session): Promise<StudioRequest | null> {
    return this.queue.claimNext(session, ['external']);
  }

  /** A thread by id, its waiting turn claimed for this session if it is an external agent's, so its checkpoint is taken. */
  getRequest(id: number, session = this.session): Promise<StudioRequest> {
    return this.queue.claim(id, session, ['external']);
  }

  /** Ends the working turn of a thread. */
  completeRequest(id: number, status: 'done' | 'failed', summary: string): Promise<StudioRequest> {
    // Only a turn an external agent works; the studio's own agents end theirs themselves.
    return this.queue.complete(id, status, summary, {}, { agents: ['external'] });
  }

  /** What the viewer's library says about a scene, for describing a thread. */
  async sceneInfo(sceneId: string): Promise<SceneInfo> {
    try {
      const { modules, entry } = await this.entry(sceneId);
      const scene = entry.scene;
      return { file: entry.file, ...(scene ? { timecode: (f: number) => modules.engine.formatTimecode(f, scene.fps) } : {}) };
    } catch {
      // The scene may have been renamed; the id still says which one.
      return {};
    }
  }

  /** A thread described for the external agent: what was asked, what is selected, and how to finish the turn. */
  async describeRequest(request: StudioRequest): Promise<string> {
    return describeThread(request, await this.sceneInfo(request.sceneId), { agent: 'external' });
  }
}
