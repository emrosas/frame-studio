// What the studio has rendered: the files under out/, for the library's
// Renders row, newest first, and serving one to play or open. Node only.

import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StudioFolder } from './folder.ts';
import { HttpError } from './http.ts';

const TYPES: Readonly<Record<string, { type: string; kind: RenderKind }>> = {
  '.mp4': { type: 'video/mp4', kind: 'video' },
  '.gif': { type: 'image/gif', kind: 'image' },
  '.png': { type: 'image/png', kind: 'image' },
  '.jpg': { type: 'image/jpeg', kind: 'image' },
  '.html': { type: 'text/html; charset=utf-8', kind: 'page' },
};

export type RenderKind = 'video' | 'image' | 'page';

export interface RenderFile {
  /** Its path under out/, with forward slashes. */
  file: string;
  /** On disk, for Reveal in Finder. */
  path: string;
  kind: RenderKind;
  bytes: number;
  /** Last modified, in ms. */
  modified: number;
}

/** The newest this many are listed; a long-used out/ holds far more than anyone browses. */
const LISTED = 60;

export async function listRenders(folder: StudioFolder): Promise<RenderFile[]> {
  const found: RenderFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() in TYPES) {
        const info = await stat(path).catch(() => null);
        if (info) found.push({ file: relative(folder.out, path).split(sep).join('/'), path, kind: TYPES[extname(entry.name).toLowerCase()].kind, bytes: info.size, modified: Math.round(info.mtimeMs) });
      }
    }
  };
  await walk(folder.out);
  return found.sort((a, b) => b.modified - a.modified).slice(0, LISTED);
}

/** Streams a file from out/, with byte ranges, which video elements need to seek. Never outside out/. */
export async function serveRender(folder: StudioFolder, file: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const root = resolve(folder.out);
  const path = resolve(root, file);
  const known = TYPES[extname(path).toLowerCase()];
  const info = known && path.startsWith(root + sep) ? await stat(path).catch(() => null) : null;
  if (!known || !info?.isFile()) throw new HttpError(404, `No render "${file}".`);
  // Symlinks included.
  const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
  if (!real.startsWith(realRoot + sep)) throw new HttpError(404, `No render "${file}".`);
  const headers: Record<string, string | number> = { 'Content-Type': known.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  // An exported page runs its own scripts: give it no standing on this origin, which holds the pairing cookie.
  if (known.kind === 'page') headers['Content-Security-Policy'] = 'sandbox allow-scripts';
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? info.size - 1 : Math.min(info.size - 1, Number(range[2]));
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    await pipeline(createReadStream(path, { start, end }), res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  await pipeline(createReadStream(path), res);
}
