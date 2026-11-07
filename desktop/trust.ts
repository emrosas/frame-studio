// Whether a project's code has changed (ADR 0017): a hash over its rigs/,
// audio/ and old films' rigs/, read before anything of theirs loads. Every file
// counts toward the hash, since a rig can read or import its neighbours; only
// TypeScript counts as code to ask about, since nothing else loads on its own.
// Electron main process only.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ProjectCode {
  /** How many source files it holds. None means there is nothing to ask. */
  files: number;
  hash: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isDirectory()) walk(path, out);
    else out.push(path);
  }
}

export function projectCode(root: string): ProjectCode {
  const paths: string[] = [];
  walk(join(root, 'rigs'), paths);
  walk(join(root, 'audio'), paths);
  let films: string[] = [];
  try {
    films = readdirSync(join(root, 'projects')).sort();
  } catch {
    // No old films.
  }
  for (const film of films) walk(join(root, 'projects', film, 'rigs'), paths);
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(`${relative(root, path).split(sep).join('/')}\0`);
    // A link's target stands in for its bytes, so a link can't send this outside the project.
    hash.update(lstatSync(path).isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path));
    hash.update('\0');
  }
  return { files: paths.filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')).length, hash: hash.digest('hex') };
}
