// A studio folder's scene files, read into the viewer's own scene library, so
// every Node tool resolves scene keys and reports errors exactly as the viewer
// and render page do. The engine and the library code are imported directly;
// rigs and generators come from the code host (tools/studio/code.ts). Entry
// points that run from source install the studio loader first
// (tools/studio/loader.ts), since src/ imports without extensions. Node only.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AudioGenerator, GeneratorRegistry } from '../src/audio/types.ts';
import * as engine from '../src/engine/index.ts';
import type { Rig, RigRegistry } from '../src/engine/types.ts';
import * as library from '../src/viewer/library.ts';
import * as selection from '../src/viewer/selection.ts';
import type { CodeHost, Definition } from './studio/code.ts';
import { REPO, type StudioFolder } from './studio/folder.ts';

/** The repo. Tests and the dev tools use it; everything else takes a studio folder. */
export const ROOT = REPO;

export type EngineModule = typeof engine;
export type LibraryModule = typeof library;
export type SelectionModule = typeof selection;

/**
 * A folder's scene files, keyed as the viewer keys them: "/project.json" for
 * the folder's own (ADR 0013), "/scenes/<file>.json" and
 * "/compositions/<file>.json", and "/projects/<id>/<file>.json" for each M9
 * project's project.json and scenes.
 */
export async function readSceneFiles(folder: Pick<StudioFolder, 'scenes' | 'projects'> & Partial<Pick<StudioFolder, 'root' | 'compositions'>>): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (folder.root) {
    const project = await readFile(join(folder.root, 'project.json'), 'utf8').catch(() => null);
    if (project !== null) files['/project.json'] = project;
  }
  for (const f of (await readdir(folder.scenes).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()) {
    files[`/scenes/${f}`] = await readFile(join(folder.scenes, f), 'utf8');
  }
  if (folder.compositions) {
    for (const f of (await readdir(folder.compositions).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()) {
      files[`/compositions/${f}`] = await readFile(join(folder.compositions, f), 'utf8');
    }
  }
  for (const project of await readdir(folder.projects, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    const dir = join(folder.projects, project.name);
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()) {
      files[`/projects/${project.name}/${f}`] = await readFile(join(dir, f), 'utf8');
    }
  }
  return files;
}

export interface LoadedModules {
  engine: EngineModule;
  library: LibraryModule;
  /** The viewer's frame-text and range rules, so every tool reads frames the same way. */
  selection: SelectionModule;
  /** The built-in rigs plus the studio folder's. Throws when two share an id. */
  createRegistry(): RigRegistry;
  /** Those plus a project's own rigs, as a project's scenes draw with. */
  createProjectRegistry(rigs: readonly Rig[]): RigRegistry;
  /** Every project's own rigs, by project id. */
  projectRigs(): Promise<Record<string, Rig[]>>;
  /** The built-in generators plus the studio folder's. Throws when two share an id. */
  createGenerators(): GeneratorRegistry;
  /**
   * validateScene with the generators, so cues are checked the way the viewer checks them, and for a
   * project scene against its project (the entry's context).
   */
  validate(input: unknown, registry?: RigRegistry, project?: engine.ProjectContext): engine.ValidationResult;
  /** Rig and generator files that failed to load, each "file: message". */
  errors: readonly string[];
  /** Where each rig and generator is defined, for the embed bundler. */
  rigDefinitions: ReadonlyMap<string, Definition>;
  projectRigDefinitions: Readonly<Record<string, ReadonlyMap<string, Definition>>>;
  generatorDefinitions: ReadonlyMap<string, Definition>;
}

function generatorRegistry(generators: readonly AudioGenerator[]): GeneratorRegistry {
  const map = new Map<string, AudioGenerator>();
  for (const generator of generators) {
    if (map.has(generator.id)) throw new Error(`duplicate generator id "${generator.id}"`);
    map.set(generator.id, generator);
  }
  return map;
}

/** The engine, the viewer's library code, and the folder's rigs and generators as the code host has them now. */
export async function loadModules(code: CodeHost): Promise<LoadedModules> {
  const loaded = await code.load();
  const rigs = [...loaded.builtinRigs, ...loaded.folderRigs];
  const createGenerators = () => generatorRegistry([...loaded.builtinGenerators, ...loaded.folderGenerators]);
  let generators: GeneratorRegistry | undefined;
  try {
    generators = createGenerators();
  } catch {
    // buildLibrary reports it; validation then goes without generators.
  }
  return {
    engine,
    library,
    selection,
    createRegistry: () => engine.createRegistry(rigs),
    createProjectRegistry: (extra) => engine.createRegistry([...rigs, ...extra]),
    projectRigs: async () => loaded.projectRigs,
    createGenerators,
    validate: (input, registry, project) => engine.validateScene(input, registry, generators, project),
    errors: loaded.errors,
    rigDefinitions: loaded.rigDefinitions,
    projectRigDefinitions: loaded.projectRigDefinitions,
    generatorDefinitions: loaded.generatorDefinitions,
  };
}

/** The scene library as the viewer would build it from the folder right now. */
export async function sceneLibrary(modules: LoadedModules, folder: StudioFolder): Promise<library.SceneLibrary> {
  return libraryFrom(modules, await readSceneFiles(folder));
}

/** The library the viewer would build from `files`, keyed as readSceneFiles keys them, e.g. to check an edit before saving it. */
export async function libraryFrom(modules: LoadedModules, files: Record<string, string>): Promise<library.SceneLibrary> {
  const lib = modules.library.buildLibrary(files, modules.engine.validateScene, modules.createRegistry, modules.createGenerators, {
    validateProject: modules.engine.validateProject,
    sceneGraphErrors: modules.engine.sceneGraphErrors,
    createProjectRegistry: modules.createProjectRegistry,
    rigs: await modules.projectRigs(),
    validateComposition: modules.engine.validateComposition,
    validateFolderProject: modules.engine.validateFolderProject as never,
  });
  return modules.errors.length > 0 ? { ...lib, errors: [...lib.errors, ...modules.errors.map((e) => `rig or generator code: ${e}`)] } : lib;
}

/** The file on disk behind a library entry. */
export function entryPath(entry: library.SceneEntry, folder: Pick<StudioFolder, 'root'>): string {
  return join(folder.root, entry.path.slice(1));
}

/**
 * Writes `data` to `path` whole: into `path`.partial first, then renamed, so
 * a failure never leaves a file that looks complete. Creates missing folders.
 * With `mode`, the file has those permissions from the moment it exists.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const partial = `${path}.partial`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(partial, data, mode !== undefined ? { mode } : {});
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}
