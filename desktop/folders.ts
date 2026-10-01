// Studio folders on disk (ADR 0008): making a new one with samples, and the
// tsconfig.json that lets an agent type-check the folder's rigs against the
// app's built-ins. Electron main process only.

import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertFilm } from '../tools/studio/convert.ts';

/** Marks a tsconfig.json as ours, so the app updates it and leaves others alone. */
const OURS = 'Written by Frame Studio: maps @frame-studio/ to the app’s built-in rigs, engine and audio. Frame Studio rewrites it when the app moves.';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** True when `dir` is missing or holds nothing but dotfiles. */
async function isEmpty(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => null);
  return names === null || names.every((n) => n.startsWith('.'));
}

/**
 * Makes the sample project at `dir` (ADR 0013): Bears' story, converted from
 * the samples' projects/bears-story into a project folder with the film as a
 * composition, plus the hello scene. A folder that already has things in it
 * is opened as it is, never overwritten.
 */
export async function createStudioFolder(dir: string, samples: string): Promise<void> {
  if (!(await isEmpty(dir))) return;
  await convertFilm(join(samples, 'projects/bears-story'), dir, samples);
  await cp(join(samples, 'scenes/hello.json'), join(dir, 'scenes/hello.json'));
}

/**
 * Writes the folder's tsconfig.json, mapping @frame-studio/ to `builtins`, unless the folder has one that
 * isn't ours (the repo does).
 */
export async function writeTsconfig(dir: string, builtins: string): Promise<void> {
  const path = join(dir, 'tsconfig.json');
  if (await exists(path)) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text.includes(OURS)) return;
  }
  const config = {
    '//': OURS,
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      paths: { '@frame-studio/*': [`${builtins}/*`] },
    },
    include: ['rigs', 'audio', 'projects'],
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}
