// What counts as a project's code, and what that code may reach (ADR 0017). The
// trust hash, the Node loader and the module service all decide here, so the
// files the user was asked about and the files that can run are the same set.
// Node built-ins only, and sync: the loader's hook imports this before anything
// else can load, and Electron's main process hashes with it. Node only.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

/** What Node or a bundler can take from an import. Nothing else may be imported, so a name can't hide code. */
const IMPORTABLE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|wasm|node)$/i;
/** Finder drops this in any folder it opens. It can't be imported, so it doesn't count as a change. */
const JUNK = '.DS_Store';

export interface CodeFile {
  path: string;
  /** Relative to the project, with forward slashes. */
  rel: string;
  /** A link's target; a link stands for that text, never for what it points at. */
  link: string | null;
  /** Not a file, a link or a folder: a pipe, say. Reading one could hang. */
  special: boolean;
}

export interface ProjectCode {
  /** How many importable files it holds. None means there is nothing to ask. */
  files: number;
  hash: string;
}

const inside = (dir: string, path: string): string | null => {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) ? rel.split(sep).join('/') : null;
};

export const isImportable = (path: string): boolean => IMPORTABLE.test(path);

function walk(root: string, dir: string, out: CodeFile[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    // Imports from here are refused, and a real one can hold a hundred thousand files.
    if (name === 'node_modules' || name === JUNK) continue;
    const path = join(dir, name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(root, path, out);
      continue;
    }
    const link = info.isSymbolicLink() ? readlinkSync(path) : null;
    out.push({ path, rel: relative(root, path).split(sep).join('/'), link, special: link === null && !info.isFile() });
  }
}

/** Walks `dir` unless a link stands in its place: a linked folder holds no code here. */
function walkReal(root: string, dir: string, out: CodeFile[]): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  walk(root, dir, out);
}

/** Every film's rigs folder, as paths under `root`. A linked film holds no code here. */
export function filmRigs(root: string): string[] {
  const projects = join(root, 'projects');
  let names: string[];
  try {
    names = readdirSync(projects).sort();
  } catch {
    return [];
  }
  return names.filter((name) => lstatSync(join(projects, name)).isDirectory()).map((name) => join(projects, name, 'rigs'));
}

/** Every file that belongs to a project's code, sorted: its rigs/, audio/ and each old film's rigs/. Dot files count. */
export function codeFiles(root: string): CodeFile[] {
  const out: CodeFile[] = [];
  for (const dir of [join(root, 'rigs'), join(root, 'audio'), ...filmRigs(root)]) walkReal(root, dir, out);
  return out;
}

/** The hash the user approves and the count they're told, over the files codeFiles lists. */
export function projectCode(root: string): ProjectCode {
  const files = codeFiles(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.rel}\0`);
    if (file.link !== null) hash.update(`link:${file.link}`);
    else if (file.special) hash.update('special');
    else {
      try {
        hash.update(readFileSync(file.path));
      } catch {
        hash.update('unreadable');
      }
    }
    hash.update('\0');
  }
  return { files: files.filter((f) => isImportable(f.rel)).length, hash: hash.digest('hex') };
}

/** The TypeScript the studio loads by itself from `dir`, tests and test helpers left out, sorted. None when it doesn't exist. */
export function sourceFiles(dir: string): string[] {
  const out: CodeFile[] = [];
  walkReal(dir, dir, out);
  return out
    .filter((f) => {
      const parts = f.rel.split('/');
      const name = parts.pop()!;
      return !parts.some((part) => part === 'testing' || part.startsWith('.')) && name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
    })
    .map((f) => f.path)
    .sort();
}

/** Where a project and its built-ins are. */
export interface CodeHome {
  root: string;
  builtins: string;
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The part of `folder` that `path` is in, read from the path as written: "rigs", "audio", a film's "projects/<id>/rigs", or null. */
export function codeFolderOf(root: string, path: string): string | null {
  const rel = inside(root, path) ?? inside(real(root) ?? root, path);
  if (rel === null) return null;
  const film = /^projects\/[^/]+\/rigs(?=\/)/.exec(rel);
  if (film) return film[0];
  const top = /^(rigs|audio)(?=\/)/.exec(rel);
  return top ? top[1] : null;
}

const shown = (home: CodeHome, path: string): string => inside(home.root, path) ?? inside(real(home.root) ?? home.root, path) ?? path;

/** Whether a real path is a built-in a project may use: the engine, rigs and generators, never the viewer or the tools. */
function isBuiltin(home: CodeHome, path: string): boolean {
  const rel = inside(real(home.builtins) ?? home.builtins, path);
  return rel !== null && /^(engine|rigs|audio)\//.test(rel);
}

/** Why `file`, itself code of a project, can't load: a link that leaves `home`'s code, node_modules, or nothing importable. Null when it can. */
export function fileRefusal(home: CodeHome, file: string, from: string = file): string | null {
  const name = shown(home, file);
  if (file.split(/[/\\]/).includes('node_modules')) return `${name} is in node_modules, and a project's code takes no packages`;
  const at = real(file);
  if (at === null) return null;
  if (isBuiltin(home, at)) return null;
  // The walk that hashes a project's code skips node_modules, so a link into it would run code Trust never saw.
  if (at.split(/[/\\]/).includes('node_modules')) return `${name} is a link into node_modules, and a project's code takes no packages`;
  const project = real(home.root) ?? home.root;
  const rel = inside(project, at);
  const film = codeFolderOf(home.root, from);
  const own = rel !== null && (/^(rigs|audio)\//.test(rel) || (film !== null && film.startsWith('projects/') && rel.startsWith(`${film}/`)));
  if (!own) {
    const where = film !== null && film.startsWith('projects/') ? `rigs/, audio/ and ${film}/` : 'rigs/ and audio/';
    return `${name} is ${at === file ? '' : `a link to ${at}, `}outside ${where}. A project's code can only reach those and the built-ins`;
  }
  if (!isImportable(at)) return `${name} isn't a file type a rig can import`;
  try {
    if (!statSync(at).isFile()) return `${name} isn't a file`;
  } catch {
    return null;
  }
  return null;
}

/**
 * Why project file `from` can't import `specifier`, which names `target` (null when no such file exists yet, for
 * the loader to report), or null when it can.
 */
export function importRefusal(home: CodeHome, from: string, specifier: string, target: string | null): string | null {
  const who = shown(home, from);
  const relativeName = specifier.startsWith('./') || specifier.startsWith('../');
  if (!relativeName && !specifier.startsWith('@frame-studio/')) return `${who} imports "${specifier}", and a project's code takes no packages: only relative paths and @frame-studio/ names`;
  if (target === null) return null;
  const why = fileRefusal(home, target, from);
  return why ? `${who} imports "${specifier}": ${why}` : null;
}

/** The folders the loader guards, by both spellings of their paths. */
const guarded = new Map<string, CodeHome>();

/** Holds `home`'s code to the rules above in Node's loader from now on. */
export function guardProject(home: CodeHome): void {
  guarded.set(home.root, home);
  const at = real(home.root);
  if (at) guarded.set(at, home);
}

/** The project whose code `file` is, or null for anything else: the built-ins, the tools, a test. */
export function homeOf(file: string): CodeHome | null {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const home = guarded.get(dir);
    if (home && codeFolderOf(dir, file) !== null) return { ...home, root: dir };
    if (dirname(dir) === dir) return null;
  }
}

/** The app's answer to "may this code load", held until the code is first read. */
export interface Approval {
  hash: string;
  /** The code changed after the user saw it. */
  refused(): void;
}

/**
 * The window between asking and loading (ADR 0017). Called right before anything of the folder's is collected or
 * served: the code must still hash as the user approved, or the folder counts as untrusted from here on. It holds
 * once, for the first read: what changes after that, an agent's new rig say, stays trusted.
 */
export function checkApproval(folder: { root: string; untrusted?: boolean; approval?: Approval }): void {
  const { approval } = folder;
  if (!approval) return;
  delete folder.approval;
  if (projectCode(folder.root).hash === approval.hash) return;
  folder.untrusted = true;
  approval.refused();
}

/** A folder's name for a dialog: a name can hold line breaks and direction marks, which would reshape the warning around it. */
export function dialogName(dir: string): string {
  const clean = basename(dir).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || 'This folder';
}
