// Scene files on disk, read into the viewer's own scene library, so every
// Node tool resolves scene keys and reports errors exactly as the viewer and
// render page do. Node only; runs as TypeScript through type stripping.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import type * as Engine from '../src/engine/index.ts';
import type { RigRegistry } from '../src/engine/types.ts';
import type * as Library from '../src/viewer/library.ts';
import type * as Selection from '../src/viewer/selection.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const SCENES_DIR = join(ROOT, 'scenes');

export type EngineModule = typeof Engine;
export type LibraryModule = typeof Library;
export type SelectionModule = typeof Selection;

/** Scene files keyed like import.meta.glob keys them in the viewer: "/scenes/<file>.json". */
export async function readSceneFiles(dir = SCENES_DIR): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const f of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    files[`/scenes/${f}`] = await readFile(join(dir, f), 'utf8');
  }
  return files;
}

export interface LoadedModules {
  engine: EngineModule;
  library: LibraryModule;
  /** The viewer's frame-text and range rules, so every tool reads frames the same way. */
  selection: SelectionModule;
  createRegistry(): RigRegistry;
}

/** The engine, the viewer's library code and the rig registry, loaded through Vite so TypeScript and extensionless imports work. */
export async function loadModules(server: ViteDevServer): Promise<LoadedModules> {
  const engine = (await server.ssrLoadModule(join(ROOT, 'src/engine/index.ts'))) as unknown as EngineModule;
  const library = (await server.ssrLoadModule(join(ROOT, 'src/viewer/library.ts'))) as unknown as LibraryModule;
  const selection = (await server.ssrLoadModule(join(ROOT, 'src/viewer/selection.ts'))) as unknown as SelectionModule;
  const rigs = (await server.ssrLoadModule(join(ROOT, 'src/rigs/index.ts'))) as { createDefaultRegistry(): RigRegistry };
  return { engine, library, selection, createRegistry: rigs.createDefaultRegistry };
}

/** The scene library as the viewer would build it from `dir` right now. */
export async function sceneLibrary(modules: LoadedModules, dir = SCENES_DIR): Promise<Library.SceneLibrary> {
  return modules.library.buildLibrary(await readSceneFiles(dir), modules.engine.validateScene, modules.createRegistry);
}

/** The file on disk behind a library entry. */
export function entryPath(entry: Library.SceneEntry, dir = SCENES_DIR): string {
  return join(dir, basename(entry.path));
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
