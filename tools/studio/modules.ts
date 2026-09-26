// The module service (ADR 0008): the studio server hands rigs and sound
// generators to pages as JavaScript, so the app needs no bundler to run the
// code agents write. Node strips each file's types, and every import is
// rewritten to a URL on this service that carries a hash of the imported file
// and everything it imports. An edit changes the URLs of that file and its
// importers only, so a page reloads just those, and everything else stays the
// same object. Hashed URLs never change content, so pages may cache them for
// good. Node only.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { sourceFiles } from './code.ts';
import type { StudioFolder } from './folder.ts';
import { findSource } from './loader.ts';

/** Where the service serves modules from: the built-ins, or the studio folder. */
type Scope = 'b' | 'f';

export const MODULES_PATH = '/__studio/m/';

/** The entry modules a page imports to build its library. */
export interface ModuleManifest {
  /** The built-ins' rigs/index.ts and audio/index.ts, which export allRigs and allGenerators. */
  builtinRigs: string;
  builtinAudio: string;
  /** Every module in the studio folder's rigs/ and audio/. */
  folderRigs: string[];
  folderAudio: string[];
  /** Every module in each project's rigs/, by project id. */
  projectRigs: Record<string, string[]>;
}

interface Compiled {
  mtimeMs: number;
  size: number;
  code: string;
  /** Static imports and re-exports, with where their specifier sits in `code`. */
  imports: { specifier: string; start: number; end: number }[];
  /** Hash of the stripped code alone. */
  own: string;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class ModuleService {
  private readonly folder: StudioFolder;
  private readonly compiled = new Map<string, Compiled>();
  /** Each file's hash with everything it imports, until the next change. */
  private deep = new Map<string, string>();

  constructor(folder: StudioFolder) {
    this.folder = folder;
  }

  /** Forgets the import hashes after files changed; each file is stripped again only if it changed. */
  invalidate(): void {
    this.deep.clear();
  }

  /** Where a scope's files may come from. */
  private allowed(file: string): { scope: Scope; path: string } | null {
    const { builtins, root, rigs, audio, projects } = this.folder;
    const under = (dir: string) => {
      const rel = relative(dir, file);
      return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) ? rel.split(sep).join('/') : null;
    };
    const b = under(builtins);
    if (b !== null && /^(engine|rigs|audio)\//.test(b)) return { scope: 'b', path: b };
    const f = under(root);
    if (f === null) return null;
    const project = under(projects);
    const code = under(rigs) !== null || under(audio) !== null || (project !== null && /^[^/]+\/rigs\//.test(project));
    return code ? { scope: 'f', path: f } : null;
  }

  private fileFor(scope: string, path: string): string | null {
    const base = scope === 'b' ? this.folder.builtins : scope === 'f' ? this.folder.root : null;
    if (base === null || path.split('/').some((part) => part === '..' || part === '')) return null;
    const file = join(base, path);
    return this.allowed(file) ? file : null;
  }

  private async compile(file: string): Promise<Compiled> {
    const info = await stat(file);
    const cached = this.compiled.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const source = await readFile(file, 'utf8');
    const code = stripTypeScriptTypes(source);
    await init;
    const [found] = parse(code, file);
    const imports = found
      // Static imports and re-exports only; type stripping leaves no type-only ones.
      .filter((i) => i.d === -1 && i.n !== undefined)
      .map((i) => ({ specifier: i.n!, start: i.s, end: i.e }));
    const compiled: Compiled = { mtimeMs: info.mtimeMs, size: info.size, code, imports, own: sha(code) };
    this.compiled.set(file, compiled);
    return compiled;
  }

  /** The file an import names, or an error saying why it can't be served. */
  private resolve(specifier: string, from: string): string {
    const named = /^@frame-studio\/(.+)$/.exec(specifier);
    let path: string;
    if (named) path = join(this.folder.builtins, named[1]);
    else if (specifier.startsWith('./') || specifier.startsWith('../')) path = join(dirname(from), specifier);
    else throw new Error(`imports "${specifier}", which is not a relative path or an @frame-studio/ name; rigs and generators take no packages`);
    const file = findSource(path);
    if (!file || !file.endsWith('.ts')) throw new Error(`imports "${specifier}", and there is no such file`);
    if (!this.allowed(file)) throw new Error(`imports "${specifier}", which is outside the rigs, generators and engine`);
    return file;
  }

  /** Every file `root` reaches through its imports: each one's own hash, the files it imports, and imports that fail. */
  private async graph(root: string): Promise<Map<string, { own: string; children: string[]; errors: string[] }>> {
    const nodes = new Map<string, { own: string; children: string[]; errors: string[] }>();
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (nodes.has(file) || this.deep.has(file)) continue;
      let compiled: Compiled;
      try {
        compiled = await this.compile(file);
      } catch (err) {
        // It won't strip; its URL still exists, and serves a module that throws why.
        nodes.set(file, { own: `!${err instanceof Error ? err.message : String(err)}`, children: [], errors: [] });
        continue;
      }
      const children: string[] = [];
      const errors: string[] = [];
      for (const { specifier } of compiled.imports) {
        try {
          const child = this.resolve(specifier, file);
          children.push(child);
          queue.push(child);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      nodes.set(file, { own: compiled.own, children, errors });
    }
    return nodes;
  }

  /**
   * The file's hash with everything it imports. Files that import each other (a cycle) share one hash over
   * all of them, so an edit to any one changes the URLs of the whole cycle and everything that imports it.
   */
  private async hash(file: string): Promise<string> {
    const known = this.deep.get(file);
    if (known) return known;
    const graph = await this.graph(file);
    // Tarjan's strongly connected components: each finishes after the ones it imports, so their hashes are ready.
    let next = 0;
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visit = (v: string) => {
      index.set(v, next);
      low.set(v, next);
      next++;
      stack.push(v);
      onStack.add(v);
      for (const w of graph.get(v)!.children) {
        if (this.deep.has(w)) continue;
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) !== index.get(v)) return;
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        members.push(w);
      } while (w !== v);
      members.sort();
      const inside = new Set(members);
      const parts: string[] = [];
      for (const m of members) {
        const node = graph.get(m)!;
        parts.push(m, node.own, ...node.errors.map((e) => `!${e}`));
        for (const c of node.children) if (!inside.has(c)) parts.push(this.deep.get(c)!);
      }
      const hash = sha(parts.join('|'));
      for (const m of members) this.deep.set(m, hash);
    };
    visit(file);
    return this.deep.get(file)!;
  }

  /** The URL a page imports `file` by. */
  async url(file: string): Promise<string> {
    const at = this.allowed(file);
    if (!at) throw new Error(`${file} is not a module the studio serves`);
    return `${MODULES_PATH}${at.scope}/${at.path}?h=${await this.hash(file)}`;
  }

  async manifest(): Promise<ModuleManifest> {
    const { builtins, rigs, audio, projects } = this.folder;
    const urls = async (files: string[]) => Promise.all(files.map((f) => this.url(f)));
    const projectRigs: Record<string, string[]> = {};
    for (const file of await sourceFiles(projects)) {
      const m = /^([^/]+)\/rigs\//.exec(relative(projects, file).split(sep).join('/'));
      if (m) (projectRigs[m[1]] ??= []).push(await this.url(file));
    }
    return {
      builtinRigs: await this.url(join(builtins, 'rigs/index.ts')),
      builtinAudio: await this.url(join(builtins, 'audio/index.ts')),
      folderRigs: await urls(await sourceFiles(rigs)),
      folderAudio: await urls(await sourceFiles(audio)),
      projectRigs,
    };
  }

  /**
   * Serves one module, at `rest` = "<scope>/<path>". A file that won't strip or resolve comes back as a module
   * that throws the reason, since a page learns nothing from a failed import but "failed to fetch".
   */
  async serve(rest: string, hash: string | null, res: ServerResponse): Promise<void> {
    const slash = rest.indexOf('/');
    const file = slash > 0 ? this.fileFor(rest.slice(0, slash), decodeURIComponent(rest.slice(slash + 1))) : null;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    if (!file) {
      res.statusCode = 404;
      res.end(`throw new Error(${JSON.stringify(`The studio serves no module at ${rest}.`)});`);
      return;
    }
    const shown = relative(this.folder.root, file).startsWith('..') ? `built-in ${relative(this.folder.builtins, file)}` : relative(this.folder.root, file);
    let code: string;
    try {
      const compiled = await this.compile(file);
      code = compiled.code;
      // Rewrite from the end, so earlier offsets stay right.
      for (const { specifier, start, end } of [...compiled.imports].sort((a, b) => b.start - a.start)) {
        code = `${code.slice(0, start)}${await this.url(this.resolve(specifier, file))}${code.slice(end)}`;
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'no-store');
      res.end(`throw new Error(${JSON.stringify(`${shown}: ${why}`)});`);
      return;
    }
    const current = await this.hash(file);
    res.statusCode = 200;
    res.setHeader('Cache-Control', hash === current ? 'private, max-age=31536000, immutable' : 'no-store');
    res.end(`${code}\n//# sourceURL=${MODULES_PATH}${rest}\n`);
  }
}
