// Turns raw scene files into a validated scene library. Pure: the caller passes
// file contents, the validator, and the registry factories, so this is
// testable without Vite or the real engine.

import type { GeneratorRegistry } from '../audio/types';
import type { ValidationResult } from '../engine';
import type { RigRegistry, Scene } from '../engine/types';

export type ValidateScene = (input: unknown, registry?: RigRegistry, generators?: GeneratorRegistry) => ValidationResult;

export interface SceneEntry {
  /** Picker and URL key: the scene id, or the file path when the id is missing or taken. */
  key: string;
  /** Module path, e.g. "/scenes/fly-test.json". */
  path: string;
  /** Repo-relative file, e.g. "scenes/fly-test.json", for messages. */
  file: string;
  /** The validated scene, or null when the file is invalid. */
  scene: Scene | null;
  /** Everything wrong with the file, each "path: message". Empty when valid. */
  errors: readonly string[];
}

export interface SceneLibrary {
  entries: readonly SceneEntry[];
  /** Null when the rig registry failed to build; nothing can render then. */
  registry: RigRegistry | null;
  /** Null when the generator list failed to build; scenes then play silent. */
  generators: GeneratorRegistry | null;
  /** Problems that affect every scene (e.g. the rig registry failed to build). */
  errors: readonly string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

function declaredId(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const id = (json as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

export function buildLibrary(
  files: Readonly<Record<string, string>>,
  validate: ValidateScene,
  createRegistry: () => RigRegistry,
  createGenerators: () => GeneratorRegistry = () => new Map(),
): SceneLibrary {
  const errors: string[] = [];
  let registry: RigRegistry | null = null;
  try {
    registry = createRegistry();
  } catch (err) {
    errors.push(`rig registry: ${message(err)} (fix the rig list in src/rigs/index.ts)`);
  }
  let generators: GeneratorRegistry | null = null;
  try {
    generators = createGenerators();
  } catch (err) {
    errors.push(`audio generators: ${message(err)} (fix the generator list in src/audio/index.ts)`);
  }

  const entries: SceneEntry[] = [];
  const byKey = new Map<string, SceneEntry>();

  for (const path of Object.keys(files).sort()) {
    const file = path.replace(/^\//, '');
    const entryErrors: string[] = [];
    let scene: Scene | null = null;
    let json: unknown;
    let parsed = false;

    try {
      json = JSON.parse(files[path]);
      parsed = true;
    } catch (err) {
      entryErrors.push(`invalid JSON: ${message(err)}`);
    }

    if (parsed) {
      try {
        const result = validate(json, registry ?? undefined, generators ?? undefined);
        if (result.ok) scene = result.scene;
        else entryErrors.push(...result.errors);
      } catch (err) {
        entryErrors.push(`validator threw: ${message(err)}`);
      }
    }

    const id = parsed ? declaredId(json) : null;
    let key = id ?? fileStem(path);
    const taken = byKey.get(key);
    if (taken && id !== null && fileStem(path) === id && fileStem(taken.path) !== id) {
      // Scene files are named after their id, so this file owns the id and the
      // other one is a copy that kept it. The copy gets the error, wherever it sorts.
      const copy: SceneEntry = {
        ...taken,
        key: taken.file,
        scene: null,
        errors: [...taken.errors, duplicateIdError(id, file)],
      };
      entries[entries.indexOf(taken)] = copy;
      byKey.set(copy.key, copy);
    } else if (taken) {
      if (id !== null) {
        entryErrors.push(duplicateIdError(id, taken.file));
        scene = null;
      }
      key = file;
    }

    const entry: SceneEntry = { key, path, file, scene, errors: entryErrors };
    byKey.set(key, entry);
    entries.push(entry);
  }

  return { entries, registry, generators, errors };
}

function duplicateIdError(id: string, owner: string): string {
  return `id: "${id}" is already used by ${owner}. Scene ids must be unique; rename one of them.`;
}

/**
 * Finds an entry by key, then by module path (keeps the selection when a scene
 * id is renamed), then by file name (?scene=probe opens scenes/probe.json
 * whatever id it declares).
 */
export function findEntry(library: SceneLibrary, key: string | null, path?: string | null): SceneEntry | null {
  if (key !== null) {
    const hit = library.entries.find((e) => e.key === key);
    if (hit) return hit;
  }
  if (path) {
    const hit = library.entries.find((e) => e.path === path);
    if (hit) return hit;
  }
  if (key !== null) {
    const hit = library.entries.find((e) => fileStem(e.path) === key);
    if (hit) return hit;
  }
  return null;
}

/**
 * The entry to open for ?scene=. Falls back to the first scene; `missing` is
 * true when a scene was requested and nothing matched it, so the viewer can
 * say so instead of silently showing another scene.
 */
export function openingEntry(library: SceneLibrary, requested: string | null): { entry: SceneEntry | null; missing: boolean } {
  const hit = findEntry(library, requested);
  return { entry: hit ?? library.entries[0] ?? null, missing: requested !== null && hit === null };
}
