// The rigs and sound generators, loaded into Node (ADR 0008): the built-ins,
// the studio folder's rigs/ and audio/, and each project's rigs/. Files load
// as TypeScript through the studio loader (loader.ts). After an edit, the next
// load imports everything again under a new version, since Node can't forget a
// module; the old copies stay in memory. Node only.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioGenerator } from '../../src/audio/types.ts';
import type { Rig } from '../../src/engine/types.ts';
import type { StudioFolder } from './folder.ts';
import { installLoader } from './loader.ts';

/** Where a rig or generator is defined: its file and export name. */
export interface Definition {
  file: string;
  name: string;
}

export interface LoadedCode {
  /** The built-in rigs, as src/rigs/index.ts lists them. */
  builtinRigs: Rig[];
  /** Every rig the studio folder's rigs/ exports. */
  folderRigs: Rig[];
  /** Each project's own rigs, by project id. */
  projectRigs: Record<string, Rig[]>;
  builtinGenerators: AudioGenerator[];
  folderGenerators: AudioGenerator[];
  /** Files that failed to load, each "file: message", relative to the studio folder or the built-ins. */
  errors: string[];
  /** Where each rig and generator is defined, for the embed bundler. A project's rigs are under their project. */
  rigDefinitions: Map<string, Definition>;
  projectRigDefinitions: Record<string, Map<string, Definition>>;
  generatorDefinitions: Map<string, Definition>;
}

export function isRig(value: unknown): value is Rig {
  const v = value as Partial<Rig> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.draw === 'function' && typeof v.params === 'object';
}

export function isGenerator(value: unknown): value is AudioGenerator {
  const v = value as Partial<AudioGenerator> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.schedule === 'function' && typeof v.params === 'object';
}

/** TypeScript sources under `dir`, tests and test helpers left out, sorted. None when it doesn't exist. */
export async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing' && entry.name !== 'node_modules' && !entry.name.startsWith('.')) out.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Node's own import(), out of reach of a bundler or test runner that rewrites import() calls, so rigs load through
 * the studio loader and reload the way they do in the app. Vitest's sandbox has no native import(); there the
 * runner's own import() stands in, and only the first load of a rig's imports counts, so the reload path is tested
 * by the app and dev server tests, which run the server in Node.
 */
const native = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
let sandboxed = false;
async function nativeImport(url: string): Promise<unknown> {
  if (!sandboxed) {
    try {
      return await native(url);
    } catch (err) {
      if (!(err instanceof TypeError && /dynamic import callback/.test(err.message))) throw err;
      sandboxed = true;
    }
  }
  return import(url);
}

export class CodeHost {
  readonly folder: StudioFolder;
  private version = 0;
  private loaded: Promise<LoadedCode> | null = null;

  constructor(folder: StudioFolder) {
    this.folder = folder;
    installLoader(folder.builtins);
  }

  /** Forgets what was loaded, so the next load reads every file again. */
  invalidate(): void {
    this.version++;
    this.loaded = null;
  }

  /** Every rig and generator, loaded once until the next invalidate. */
  load(): Promise<LoadedCode> {
    if (!this.loaded) {
      const attempt = this.loadNow(this.version);
      this.loaded = attempt;
      attempt.catch(() => {
        if (this.loaded === attempt) this.loaded = null;
      });
    }
    return this.loaded;
  }

  /** A built-in module, loaded as the rigs are, e.g. "rigs/type/faces/index.ts". */
  importBuiltin(path: string): Promise<Record<string, unknown>> {
    return this.importFile(join(this.folder.builtins, path), this.version);
  }

  private shown(file: string): string {
    const { root, builtins } = this.folder;
    const inside = (dir: string) => !relative(dir, file).startsWith('..');
    return inside(root) ? relative(root, file) : inside(builtins) ? `built-in ${relative(builtins, file)}` : file;
  }

  private async importFile(file: string, version: number): Promise<Record<string, unknown>> {
    return (await nativeImport(`${pathToFileURL(file).href}?gen=${version}`)) as Record<string, unknown>;
  }

  /**
   * Imports every module under `dirs` and collects the values `matches` accepts, with where each is defined.
   * A module that only re-exports (an index) loses to the one that defines the value.
   */
  private async collect<T extends { id: string }>(
    dirs: string[],
    matches: (v: unknown) => v is T,
    version: number,
    errors: string[],
  ): Promise<{ values: T[]; definitions: Map<string, Definition> }> {
    const values: T[] = [];
    const found = new Map<string, Definition & { index: boolean }>();
    for (const dir of dirs) {
      for (const file of await sourceFiles(dir)) {
        let mod: Record<string, unknown>;
        try {
          mod = await this.importFile(file, version);
        } catch (err) {
          errors.push(`${this.shown(file)}: ${message(err)}`);
          continue;
        }
        const index = file.endsWith('/index.ts');
        for (const [name, value] of Object.entries(mod)) {
          if (!matches(value)) continue;
          if (!values.includes(value)) values.push(value);
          const prev = found.get(value.id);
          if (!prev || (prev.index && !index)) found.set(value.id, { file, name, index });
        }
      }
    }
    return { values, definitions: new Map([...found].map(([id, { file, name }]) => [id, { file, name }])) };
  }

  private async loadNow(version: number): Promise<LoadedCode> {
    const { builtins, rigs, audio, projects } = this.folder;
    const errors: string[] = [];
    const builtinRigsMod = await this.importFile(join(builtins, 'rigs/index.ts'), version);
    const builtinAudioMod = await this.importFile(join(builtins, 'audio/index.ts'), version);
    const builtinRigs = [...((builtinRigsMod.allRigs as readonly Rig[]) ?? [])];
    const builtinGenerators = [...((builtinAudioMod.allGenerators as readonly AudioGenerator[]) ?? [])];
    const builtinRigDefs = await this.collect([join(builtins, 'rigs')], isRig, version, errors);
    const builtinGenDefs = await this.collect([join(builtins, 'audio')], isGenerator, version, errors);
    const folderRigs = await this.collect([rigs], isRig, version, errors);
    const folderGenerators = await this.collect([audio], isGenerator, version, errors);
    const projectRigs: Record<string, Rig[]> = {};
    const projectRigDefinitions: Record<string, Map<string, Definition>> = {};
    for (const entry of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const own = await this.collect([join(projects, entry.name, 'rigs')], isRig, version, errors);
      if (own.values.length > 0) projectRigs[entry.name] = own.values;
      projectRigDefinitions[entry.name] = own.definitions;
    }
    return {
      builtinRigs,
      folderRigs: folderRigs.values,
      projectRigs,
      builtinGenerators,
      folderGenerators: folderGenerators.values,
      errors,
      rigDefinitions: new Map([...builtinRigDefs.definitions, ...folderRigs.definitions]),
      projectRigDefinitions,
      generatorDefinitions: new Map([...builtinGenDefs.definitions, ...folderGenerators.definitions]),
    };
  }
}
