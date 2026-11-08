// Writes a generated file into a project's media/ under a name we pick (ADR
// 0017). The name never comes from a page, an agent or a provider. Written
// beside the target first and linked into place, which fails rather than
// overwrite anything, so the file watcher never sees half a file. A disk without
// hard links gets an exclusive copy instead, which can show half a file until it
// ends. A media/ that is a link out of the project is refused, since projects
// are not trusted.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, link, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** A problem saving, in words fit to show. */
export class SaveRefused extends Error {}

const CANT_WRITE = 'Frame Studio can\'t write to this project\'s media folder.';

/** The project's media/ as a real path, made if need be. */
export async function mediaFolder(root: string): Promise<string> {
  try {
    await mkdir(join(root, 'media'), { recursive: true });
  } catch {
    throw new SaveRefused(CANT_WRITE);
  }
  return inProject(root);
}

/** Checks media/ before anything is billed, so a bad folder costs nothing. Changes nothing on disk: Cancel leaves no trace. */
export async function checkMediaFolder(root: string): Promise<void> {
  // lstat, so a dangling link counts as there: it can't take a file either.
  const exists = await lstat(join(root, 'media')).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
  );
  const folder = exists ? await inProject(root) : root;
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error('not a folder');
    await access(folder, constants.W_OK | constants.X_OK);
  } catch {
    throw new SaveRefused(CANT_WRITE);
  }
}

async function inProject(root: string): Promise<string> {
  try {
    const [realRoot, realMedia] = await Promise.all([realpath(root), realpath(join(root, 'media'))]);
    // A folder named Media answers to media/ on a disk that ignores case.
    const inside = relative(realRoot, realMedia).toLowerCase();
    if (inside === 'media' || inside.startsWith(`media${sep}`)) return realMedia;
  } catch {
    throw new SaveRefused(CANT_WRITE);
  }
  throw new SaveRefused('This project\'s media folder points outside the project, so nothing was saved.');
}

export async function saveVoiceFile(root: string, source: string, ext: string, bytes: Uint8Array): Promise<string> {
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) throw new SaveRefused(`"${ext}" is not a file type the studio saves.`);
  const realMedia = await mediaFolder(root);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const partial = join(realMedia, `.voice-${randomUUID()}.part`);
  try {
    await writeFile(partial, bytes, { flag: 'wx', mode: 0o644 });
    for (let n = 1; ; n++) {
      const name = `voice-${source}-${stamp}${n === 1 ? '' : `-${n}`}${ext}`;
      try {
        await place(partial, join(realMedia, name));
        return `media/${name}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } finally {
    await rm(partial, { force: true });
  }
}

/** Puts `partial` at `target`, failing if it exists. A disk without hard links, such as exFAT, gets an exclusive copy. */
async function place(partial: string, target: string): Promise<void> {
  try {
    await link(partial, target);
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'ENOSYS') throw err;
    await copyFile(partial, target, constants.COPYFILE_EXCL);
  }
}
