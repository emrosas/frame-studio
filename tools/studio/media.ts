// The studio folder's sound files (ADR 0012): media/, where voiceover and
// music live for scenes' file cues. The server lists them with their lengths,
// serves them to its pages, takes uploads from the viewer straight to disk,
// and copies a file in from elsewhere on disk. Node only.

import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import { isMediaPath } from '../../src/engine/validate.ts';
import type { StudioFolder } from './folder.ts';
import { HttpError } from './http.ts';

/** Sound file types the studio takes, by extension, with what to serve them as. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

/** Largest sound file an upload or an import takes. */
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;

export interface MediaFile {
  /** Its path in scenes, e.g. "media/voice.mp3". */
  file: string;
  bytes: number;
  /** Last modified, in ms, so a page knows to decode a replaced file again. */
  modified: number;
}

export interface MediaInfo extends MediaFile {
  /** Seconds, when the file's header says. */
  duration?: number;
  channels?: number;
  sampleRate?: number;
}

const isSound = (name: string) => extname(name).toLowerCase() in MEDIA_TYPES;

/** Every sound file under media/, sorted by path. */
export async function listMedia(folder: StudioFolder): Promise<MediaFile[]> {
  const root = join(folder.root, 'media');
  const out: MediaFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && isSound(entry.name)) {
        const info = await stat(path).catch(() => null);
        if (info) out.push({ file: relative(folder.root, path).split(sep).join('/'), bytes: info.size, modified: Math.round(info.mtimeMs) });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The files with their lengths, read from their headers. */
export async function mediaInfo(folder: StudioFolder): Promise<MediaInfo[]> {
  return Promise.all(
    (await listMedia(folder)).map(async (m) => {
      try {
        const { format } = await parseFile(join(folder.root, m.file), { duration: true, skipCovers: true });
        return {
          ...m,
          ...(format.duration !== undefined ? { duration: Math.round(format.duration * 1000) / 1000 } : {}),
          ...(format.numberOfChannels !== undefined ? { channels: format.numberOfChannels } : {}),
          ...(format.sampleRate !== undefined ? { sampleRate: format.sampleRate } : {}),
        };
      } catch {
        return m;
      }
    }),
  );
}

/** The file on disk behind a scene's media path, or a 404. Never outside media/. */
export function mediaPath(folder: StudioFolder, file: string): string {
  const root = resolve(folder.root, 'media');
  const path = resolve(folder.root, file);
  if (!isMediaPath(file) || !isSound(file) || !path.startsWith(root + sep)) throw new HttpError(404, `No sound file "${file}".`);
  return path;
}

/** Streams a sound file to a page. */
export async function serveMedia(folder: StudioFolder, file: string, res: import('node:http').ServerResponse): Promise<void> {
  const path = mediaPath(folder, file);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, `No sound file "${file}".`);
  res.writeHead(200, { 'Content-Type': MEDIA_TYPES[extname(path).toLowerCase()], 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  await pipeline(createReadStream(path), res);
}

/** "My Voice Take (final).MP3" -> "my-voice-take-final.mp3". */
function fileName(name: string): string {
  const ext = extname(name).toLowerCase();
  const stem = basename(name, extname(name))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${stem || 'sound'}${ext}`;
}

/** A free media/ path for `name`: its slug, numbered if taken. */
async function freePath(folder: StudioFolder, name: string): Promise<{ path: string; file: string }> {
  const dir = join(folder.root, 'media');
  await mkdir(dir, { recursive: true });
  const clean = fileName(name);
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let n = 1; ; n++) {
    const file = `${stem}${n === 1 ? '' : `-${n}`}${ext}`;
    const path = join(dir, file);
    if (!(await stat(path).catch(() => null))) return { path, file: `media/${file}` };
  }
}

/** Saves an upload, streamed to disk, as media/<slug>.<ext>. Returns its path in scenes. */
export async function saveMedia(folder: StudioFolder, name: string, req: IncomingMessage): Promise<string> {
  if (!isSound(name)) throw new HttpError(415, `Sound files must be ${Object.keys(MEDIA_TYPES).join(', ')}.`);
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > MAX_MEDIA_BYTES) throw new HttpError(413, `The file is over the ${MAX_MEDIA_BYTES / 1024 / 1024 / 1024} GB limit.`);
  const { path, file } = await freePath(folder, name);
  const partial = `${path}.part`;
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_MEDIA_BYTES) req.destroy(new HttpError(413, `The file is over the ${MAX_MEDIA_BYTES / 1024 / 1024 / 1024} GB limit.`));
  });
  try {
    await pipeline(req, createWriteStream(partial));
    if (size === 0) throw new HttpError(400, 'The file is empty.');
    await rename(partial, path);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return file;
}

/** Copies a sound file from anywhere on disk into media/. Returns its path in scenes. */
export async function importMedia(folder: StudioFolder, source: string): Promise<string> {
  if (!isSound(source)) throw new Error(`Sound files must be ${Object.keys(MEDIA_TYPES).join(', ')}; got ${basename(source)}.`);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new Error(`No file at ${source}.`);
  if (info.size > MAX_MEDIA_BYTES) throw new Error(`${basename(source)} is over the ${MAX_MEDIA_BYTES / 1024 / 1024 / 1024} GB limit.`);
  const { path, file } = await freePath(folder, basename(source));
  await copyFile(source, path);
  return file;
}
