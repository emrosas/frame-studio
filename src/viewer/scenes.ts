// The scene library, loaded from the studio server (ADR 0008): the scene and
// project files from its file store, and the rigs and sound generators from
// its module service, imported by URL. The viewer and the render worker both
// build their library here, and build it again when the server says files
// changed. Module URLs carry a hash of the file and everything it imports, so
// a second load imports only what changed; the rest are the same objects.

import type { AudioGenerator, GeneratorRegistry } from '../audio/types';
import { createRegistry, isRig, sceneGraphErrors, validateComposition, validateFolderProject, validateProject, validateScene, type Rig } from '../engine';
import { buildLibrary, type SceneLibrary } from './library';

interface ModuleManifest {
  builtinRigs: string;
  builtinAudio: string;
  folderRigs: string[];
  folderAudio: string[];
  projectRigs: Record<string, string[]>;
}

export interface LoadedLibrary {
  library: SceneLibrary;
  /** The server's file generation this library reflects. */
  generation: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The studio server answered ${res.status} for ${path}.`);
  return data;
}

function isGenerator(value: unknown): value is AudioGenerator {
  const v = value as Partial<AudioGenerator> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.schedule === 'function' && typeof v.params === 'object';
}

function generatorRegistry(generators: readonly AudioGenerator[]): GeneratorRegistry {
  const map = new Map<string, AudioGenerator>();
  for (const generator of generators) {
    if (map.has(generator.id)) throw new Error(`duplicate generator id "${generator.id}"`);
    map.set(generator.id, generator);
  }
  return map;
}

export async function loadLibrary(): Promise<LoadedLibrary> {
  const [files, { modules }] = await Promise.all([
    getJson<{ generation: number; files: Record<string, string>; media?: { file: string; bytes: number; modified: number }[] }>('/__studio/files'),
    getJson<{ modules: ModuleManifest }>('/__studio/modules'),
  ]);
  const errors: string[] = [];
  const load = async (url: string): Promise<Record<string, unknown>> => {
    try {
      return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    } catch (err) {
      errors.push(`rig or generator code: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };
  /** Every value the modules at `urls` export that `matches` accepts, once each. */
  const collect = async <T>(urls: string[], matches: (v: unknown) => v is T): Promise<T[]> => {
    const out: T[] = [];
    for (const mod of await Promise.all(urls.map(load))) for (const value of Object.values(mod)) if (matches(value) && !out.includes(value)) out.push(value);
    return out;
  };
  const [builtinRigs, builtinAudio, folderRigs, folderGenerators] = await Promise.all([
    load(modules.builtinRigs),
    load(modules.builtinAudio),
    collect(modules.folderRigs, isRig),
    collect(modules.folderAudio, isGenerator),
  ]);
  const projectRigs: Record<string, Rig[]> = {};
  for (const [project, urls] of Object.entries(modules.projectRigs)) projectRigs[project] = await collect(urls, isRig);
  const rigs = [...((builtinRigs.allRigs as readonly Rig[] | undefined) ?? []), ...folderRigs];
  const generators = [...((builtinAudio.allGenerators as readonly AudioGenerator[] | undefined) ?? []), ...folderGenerators];

  const library = buildLibrary(files.files, validateScene, () => createRegistry(rigs), () => generatorRegistry(generators), {
    validateProject,
    sceneGraphErrors,
    createProjectRegistry: (own) => createRegistry([...rigs, ...own]),
    rigs: projectRigs,
    validateComposition,
    validateFolderProject: validateFolderProject as never,
  });
  const withMedia = { ...library, media: files.media ?? [] };
  return { library: errors.length > 0 ? { ...withMedia, errors: [...library.errors, ...errors] } : withMedia, generation: files.generation };
}
