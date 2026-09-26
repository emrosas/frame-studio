// Scene files on disk, read into the viewer's own scene library, so every
// Node tool resolves scene keys and reports errors exactly as the viewer and
// render page do. Node only; runs as TypeScript through type stripping.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import type * as Audio from '../src/audio/index.ts';
import type * as Engine from '../src/engine/index.ts';
import type { Rig, RigRegistry } from '../src/engine/types.ts';
import type * as Library from '../src/viewer/library.ts';
import type * as Selection from '../src/viewer/selection.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const SCENES_DIR = join(ROOT, 'scenes');
/** Project folders (ADR 0007): projects/<id>/project.json, its scenes, and rigs/. */
export const PROJECTS_DIR = join(ROOT, 'projects');

export type EngineModule = typeof Engine;
export type LibraryModule = typeof Library;
export type SelectionModule = typeof Selection;

/**
 * Scene files keyed like import.meta.glob keys them in the viewer:
 * "/scenes/<file>.json" for loose scenes, and "/projects/<id>/<file>.json"
 * for each project's project.json and scenes.
 */
export async function readSceneFiles(dir = SCENES_DIR, projectsDir = PROJECTS_DIR): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const f of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    files[`/scenes/${f}`] = await readFile(join(dir, f), 'utf8');
  }
  for (const project of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    const folder = join(projectsDir, project.name);
    for (const f of (await readdir(folder)).filter((name) => name.endsWith('.json')).sort()) {
      files[`/projects/${project.name}/${f}`] = await readFile(join(folder, f), 'utf8');
    }
  }
  return files;
}

export interface LoadedModules {
  engine: EngineModule;
  library: LibraryModule;
  /** The viewer's frame-text and range rules, so every tool reads frames the same way. */
  selection: SelectionModule;
  createRegistry(): RigRegistry;
  /** The global rigs plus a project's own, as a project's scenes draw with. */
  createProjectRegistry(rigs: readonly Rig[]): RigRegistry;
  /** Every project's own rigs, loaded from projects/<id>/rigs/ (or `projectsDir`), by project id. */
  projectRigs(projectsDir?: string): Promise<Record<string, Rig[]>>;
  createGenerators(): Audio.GeneratorRegistry;
  /**
   * validateScene with the shipped audio generators, so cues are checked the way the viewer checks them,
   * and for a project scene against its project (the entry's context).
   */
  validate(input: unknown, registry?: RigRegistry, project?: Engine.ProjectContext): Engine.ValidationResult;
}

/** The engine, the viewer's library code, the rigs and the audio generators, loaded through Vite so TypeScript and extensionless imports work. */
export async function loadModules(server: ViteDevServer): Promise<LoadedModules> {
  const engine = (await server.ssrLoadModule(join(ROOT, 'src/engine/index.ts'))) as unknown as EngineModule;
  const library = (await server.ssrLoadModule(join(ROOT, 'src/viewer/library.ts'))) as unknown as LibraryModule;
  const selection = (await server.ssrLoadModule(join(ROOT, 'src/viewer/selection.ts'))) as unknown as SelectionModule;
  const rigs = (await server.ssrLoadModule(join(ROOT, 'src/rigs/index.ts'))) as { createDefaultRegistry(): RigRegistry; allRigs: readonly Rig[] };
  const audio = (await server.ssrLoadModule(join(ROOT, 'src/audio/index.ts'))) as unknown as typeof Audio;
  const generators = audio.createDefaultGenerators();
  return {
    engine,
    library,
    selection,
    createRegistry: rigs.createDefaultRegistry,
    createProjectRegistry: (extra) => engine.createRegistry([...rigs.allRigs, ...extra]),
    projectRigs: (projectsDir) => loadProjectRigs(server, engine, projectsDir),
    createGenerators: audio.createDefaultGenerators,
    validate: (input, registry, project) => engine.validateScene(input, registry, generators, project),
  };
}

/** Every rig exported by a module in projects/<id>/rigs/, by project id, loaded through Vite. */
async function loadProjectRigs(server: ViteDevServer, engine: EngineModule, projectsDir = PROJECTS_DIR): Promise<Record<string, Rig[]>> {
  const out: Record<string, Rig[]> = {};
  for (const project of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    const dir = join(projectsDir, project.name, 'rigs');
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts')).sort()) {
      const mod = (await server.ssrLoadModule(join(dir, f))) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        if (engine.isRig(value) && !(out[project.name] ??= []).includes(value)) out[project.name].push(value);
      }
    }
  }
  return out;
}

/** The scene library as the viewer would build it from disk right now: loose scenes in `dir`, and every project in `projectsDir`. */
export async function sceneLibrary(modules: LoadedModules, dir = SCENES_DIR, projectsDir = PROJECTS_DIR): Promise<Library.SceneLibrary> {
  return libraryFrom(modules, await readSceneFiles(dir, projectsDir), projectsDir);
}

/** The library the viewer would build from `files`, keyed as readSceneFiles keys them, e.g. to check an edit before saving it. */
export async function libraryFrom(modules: LoadedModules, files: Record<string, string>, projectsDir = PROJECTS_DIR): Promise<Library.SceneLibrary> {
  return modules.library.buildLibrary(files, modules.engine.validateScene, modules.createRegistry, modules.createGenerators, {
    validateProject: modules.engine.validateProject,
    sceneGraphErrors: modules.engine.sceneGraphErrors,
    createProjectRegistry: modules.createProjectRegistry,
    rigs: await modules.projectRigs(projectsDir),
  });
}

/** The file on disk behind a library entry: in `dir` for a loose scene, in its folder in `projectsDir` otherwise. */
export function entryPath(entry: Library.SceneEntry, dir = SCENES_DIR, projectsDir = PROJECTS_DIR): string {
  return entry.project !== null ? join(projectsDir, entry.path.slice('/projects/'.length)) : join(dir, basename(entry.path));
}

/**
 * Writes `data` to `path` whole: into `path`.partial first, then renamed, so
 * a failure never leaves a file that looks complete. Creates missing folders.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const partial = `${path}.partial`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(partial, data);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}
