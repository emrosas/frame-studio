// Writes a generated file into a project's media/ under a name we pick (ADR
// 0017). The name never comes from a page, an agent or a provider. Written
// beside the target first, so the file watcher never sees half a file, and
// linked into place, which fails rather than overwrite anything. A media/ that
// is a link out of the project is refused, since projects are not trusted.

import { constants } from 'node:fs';
import { access, copyFile, link, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** A problem saving, in words fit to show. */
export class SaveRefused extends Error {}

/** The project's media/ as a real path, made if need be. */
export async function mediaFolder(root: string): Promise<string> {
  try {
    await mkdir(join(root, 'media'), { recursive: true });
  } catch {
    throw new SaveRefused('Frame Studio can\'t write to this project\'s media folder.');
  }
  return inProject(root);
}

/** Checks media/ before anything is billed, so a bad folder costs nothing. Changes nothing on disk: Cancel leaves no trace. */
export async function checkMediaFolder(root: string): Promise<void> {
  const exists = await access(join(root, 'media'), constants.F_OK).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
  );
  if (exists) await inProject(root);
}

async function inProject(root: string): Promise<string> {
  try {
    const [realRoot, realMedia] = await Promise.all([realpath(root), realpath(join(root, 'media'))]);
    const inside = relative(realRoot, realMedia);
    if (inside === 'media' || inside.startsWith(`media${sep}`)) return realMedia;
  } catch {
    throw new SaveRefused('Frame Studio can\'t write to this project\'s media folder.');
  }
  throw new SaveRefused('This project\'s media folder points outside the project, so nothing was saved.');
}

export async function saveVoiceFile(root: string, source: string, ext: string, bytes: Uint8Array): Promise<string> {
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) throw new SaveRefused(`"${ext}" is not a file type the studio saves.`);
  const realMedia = await mediaFolder(root);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const partial = join(realMedia, `.voice-${process.pid}-${Date.now()}.part`);
  await writeFile(partial, bytes, { flag: 'wx', mode: 0o644 });
  try {
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
