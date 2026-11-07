// Writes a generated file into a project's media/ under a name we pick (ADR
// 0017). The name never comes from a page, an agent or a provider. Written
// beside the target first, so the file watcher never sees half a file, and
// linked into place, which fails rather than overwrite anything. A media/ that
// is a link out of the project is refused, since projects are not trusted.

import { link, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export async function saveVoiceFile(root: string, source: string, ext: string, bytes: Uint8Array): Promise<string> {
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) throw new Error(`"${ext}" is not a file type the studio saves.`);
  const media = join(root, 'media');
  await mkdir(media, { recursive: true });
  const [realRoot, realMedia] = await Promise.all([realpath(root), realpath(media)]);
  const inside = relative(realRoot, realMedia);
  if (inside !== 'media' && !inside.startsWith(`media${sep}`)) throw new Error('This project\'s media folder points outside the project, so nothing was saved.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const partial = join(realMedia, `.voice-${process.pid}-${Date.now()}.part`);
  await writeFile(partial, bytes, { flag: 'wx', mode: 0o644 });
  try {
    for (let n = 1; ; n++) {
      const name = `voice-${source}-${stamp}${n === 1 ? '' : `-${n}`}${ext}`;
      try {
        await link(partial, join(realMedia, name));
        return `media/${name}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } finally {
    await rm(partial, { force: true });
  }
}
