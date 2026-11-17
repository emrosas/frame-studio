// HTML layers (ADR 0021): the studio folder's html/, where a still's pages
// live with their stylesheets, fonts and images beside them. This serves them
// to the viewer and the render worker under a policy that runs no scripts and
// loads nothing from another origin, lists them so pages know when one
// changed, and imports pages from elsewhere on this computer, copying what
// they use and bringing what they load from the network into the folder, so a
// render never depends on it. Node only.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StudioFolder } from './folder.ts';
import { HttpError } from './http.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * What a page may do. No scripts, frames, forms or plugins, and nothing from another origin: a page's
 * pixels then depend on the files in html/ and the browser build alone, and Chromium's HTML-in-Canvas
 * refuses to paint cross-origin images anyway. Inline styles stay, since slides are written with them.
 */
export const HTML_POLICY = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'none'",
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-same-origin',
].join('; ');

/** What the viewer's page finds in place of a page that isn't there, since an iframe gets no status code. */
const MISSING = '<!doctype html><title>frame-studio:missing</title>';

const safe = (file: string): boolean => file.startsWith('html/') && !file.includes('\\') && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** Streams a file under html/ to a page, with the policy pages render under. */
export async function serveHtml(folder: StudioFolder, file: string, res: ServerResponse): Promise<void> {
  const ext = extname(file).toLowerCase();
  const type = TYPES[ext];
  const headers = { 'Content-Security-Policy': HTML_POLICY, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  const path = safe(file) && type ? join(folder.root, file) : null;
  const info = path ? await stat(path).catch(() => null) : null;
  if (!path || !info?.isFile()) {
    if (ext === '.html' || ext === '.htm') {
      res.writeHead(404, { ...headers, 'Content-Type': TYPES['.html'], 'Content-Length': Buffer.byteLength(MISSING) });
      res.end(MISSING);
      return;
    }
    throw new HttpError(404, `No file "${file}".`);
  }
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': info.size });
  await pipeline(createReadStream(path), res);
}

/** Every file under html/ with its size and time, so a page can tell when one changed. At most 5000. */
export async function listHtml(folder: StudioFolder): Promise<{ file: string; size: number; mtime: number }[]> {
  const out: { file: string; size: number; mtime: number }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 5000 || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, `${rel}${entry.name}/`);
      else if (entry.isFile()) {
        const info = await stat(path).catch(() => null);
        if (info) out.push({ file: `${rel}${entry.name}`, size: info.size, mtime: Math.round(info.mtimeMs) });
      }
    }
  };
  await walk(join(folder.root, 'html'), 'html/');
  return out;
}

// ---- importing pages ----

/** What a page or stylesheet points at. */
interface Ref {
  /** The text to replace, exactly as written. */
  raw: string;
  url: string;
}

const isRemote = (url: string): boolean => /^(https?:)?\/\//i.test(url);
const isLocal = (url: string): boolean => url !== '' && !isRemote(url) && !/^(data|blob|about|javascript|mailto|tel):/i.test(url) && !url.startsWith('#');
const decode = (url: string): string => url.replace(/&amp;/g, '&').trim();

/** The url() and @import targets of a stylesheet. */
export function cssRefs(css: string): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = raw.trim();
    if (url && !seen.has(raw)) {
      seen.add(raw);
      out.push({ raw, url });
    }
  };
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g)) add(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/g)) add(m[1] ?? m[2] ?? '');
  return out;
}

/** What a page loads: src, href and poster on anything but a link to follow, and the urls in its styles. */
export function htmlRefs(html: string): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (raw.trim() && !seen.has(raw)) {
      seen.add(raw);
      out.push({ raw, url: decode(raw) });
    }
  };
  for (const tag of html.matchAll(/<(?!\/|a[\s>]|!--)([a-zA-Z][\w:-]*)\b[^>]*>/g)) {
    for (const attr of tag[0].matchAll(/\s(?:src|href|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(attr[1] ?? attr[2] ?? '');
    for (const style of tag[0].matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) for (const ref of cssRefs(decode(style[1] ?? style[2] ?? ''))) add(ref.raw);
  }
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const ref of cssRefs(block[1])) add(ref.raw);
  return out;
}

const isText = (file: string): boolean => /\.(html?|css)$/i.test(file);
const refsOf = (file: string, text: string): Ref[] => (/\.css$/i.test(file) ? cssRefs(text) : htmlRefs(text));
const stripQuery = (url: string): string => url.replace(/[?#].*$/, '');

/** Replaces each reference, wherever it is written, with what `to` gives for it. */
function rewrite(text: string, refs: readonly Ref[], to: (ref: Ref) => string | null): string {
  let out = text;
  for (const ref of refs) {
    const next = to(ref);
    if (next !== null && next !== ref.raw) out = out.split(ref.raw).join(next);
  }
  return out;
}

const EXT_OF_TYPE: Record<string, string> = {
  'text/css': '.css',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff2': '.woff2',
};

export interface HtmlImport {
  /** The folder the pages went to, under html/. */
  name: string;
  /** The pages, as a layer names them: "html/launch/1.html", in the order given. */
  pages: string[];
  /** Files copied from this computer. */
  copied: number;
  /** What the pages loaded from the network, now files beside them. */
  localized: { url: string; file: string }[];
  /** What couldn't be fetched. These stay as written, and won't load. */
  failed: { url: string; error: string }[];
}

export interface HtmlImportOptions {
  /** The folder under html/ to import into; taken from the pages' folder when left out, and numbered if it exists. */
  name?: string;
  /** For tests: what fetches a remote file. */
  fetch?: typeof fetch;
}

const slug = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'pages';

/** Pages sort as people count them: 2.html before 10.html. */
const byNumber = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const MAX_FILES = 500;
const MAX_REMOTE = 100;
const MAX_REMOTE_BYTES = 50 * 1024 * 1024;
/** Google Fonts answers by browser: this asks for what Chromium gets, woff2 by unicode range. It names no one. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** The .html files a list of paths names: each file, and every page directly in each folder, in counting order. */
export async function htmlSources(paths: readonly string[], base: string): Promise<string[]> {
  const out: string[] = [];
  for (const given of paths) {
    const path = isAbsolute(given) ? given : resolve(base, given);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error(`No file or folder at ${given}.`);
    if (info.isDirectory()) {
      const pages = (await readdir(path)).filter((f) => /\.html?$/i.test(f)).sort(byNumber);
      if (pages.length === 0) throw new Error(`${given} has no .html files directly in it.`);
      out.push(...pages.map((f) => join(path, f)));
    } else if (/\.html?$/i.test(path)) out.push(path);
    else throw new Error(`${given} is not an .html file.`);
  }
  if (out.length === 0) throw new Error('Give at least one .html file, or a folder of them.');
  if (new Set(out).size !== out.length) throw new Error('The same page is listed twice.');
  return out;
}

/**
 * Brings pages into html/<name>/ with everything they use. Local files keep their places relative to
 * each other, so the pages' own paths still work. What a page loads from the network is fetched once
 * into html/<name>/_remote/ and the page is pointed at the copy, since a page renders with no network.
 * A page already under the folder's html/ is left where it is.
 */
export async function importHtml(folder: StudioFolder, sources: readonly string[], options: HtmlImportOptions = {}): Promise<HtmlImport> {
  const home = join(folder.root, 'html');
  const inside = sources.filter((s) => s.startsWith(home + sep));
  if (inside.length === sources.length) {
    return { name: relative(home, dirname(sources[0])).split(sep)[0] ?? '', pages: sources.map((s) => relative(folder.root, s).split(sep).join('/')), copied: 0, localized: [], failed: [] };
  }
  if (inside.length > 0) throw new Error("Some pages are already in this folder's html/ and some aren't. Import the new ones on their own.");

  // Every local file the pages reach, through stylesheets too.
  const files = new Set<string>();
  const missing: string[] = [];
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    if (files.size >= MAX_FILES) throw new Error(`These pages reach over ${MAX_FILES} files. Import fewer at a time.`);
    files.add(file);
    if (!isText(file)) return;
    for (const ref of refsOf(file, await readFile(file, 'utf8'))) {
      if (!isLocal(ref.url)) continue;
      const target = resolve(dirname(file), decodeURIComponent(stripQuery(ref.url)));
      const info = await stat(target).catch(() => null);
      if (info?.isFile()) await visit(target);
      else missing.push(`${relative(dirname(file), target)} (from ${basename(file)})`);
    }
  };
  for (const source of sources) await visit(source);
  if (missing.length > 0) throw new Error(`These pages name files that aren't there:\n${[...new Set(missing)].join('\n')}`);

  // The folder they all share, so their relative paths survive the copy.
  let root = dirname(sources[0]);
  for (const file of files) while (!file.startsWith(root + sep)) root = dirname(root);
  if (root === dirname(root) || root === homedir()) throw new Error('These pages and the files they use are too far apart to copy as one folder. Put them under one folder first.');

  const wanted = slug(options.name ?? basename(dirname(sources[0])));
  let name = wanted;
  for (let n = 2; await stat(join(home, name)).catch(() => null); n++) name = `${wanted}-${n}`;
  const dest = join(home, name);
  const remoteDir = join(dest, '_remote');
  const get = options.fetch ?? fetch;

  const localized = new Map<string, string>();
  const failed = new Map<string, string>();
  /** Fetches a remote file into _remote/ once, and what it loads in turn. Returns its path, or null when it can't be had. */
  const bring = async (url: string): Promise<string | null> => {
    const absolute = url.startsWith('//') ? `https:${url}` : url;
    const known = localized.get(absolute);
    if (known) return known;
    if (failed.has(absolute)) return null;
    try {
      if (localized.size >= MAX_REMOTE) throw new Error(`over ${MAX_REMOTE} remote files`);
      const res = await get(absolute, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_REMOTE_BYTES) throw new Error('over 50 MB');
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const fromPath = extname(new URL(absolute).pathname).toLowerCase();
      const ext = EXT_OF_TYPE[type] ?? (TYPES[fromPath] ? fromPath : '');
      if (!ext) throw new Error(`it is ${type || 'of no type'}, which a page can't use`);
      const path = join(remoteDir, `${createHash('sha256').update(absolute).digest('hex').slice(0, 16)}${ext}`);
      // Before its own files are fetched, so a stylesheet that imports itself ends.
      localized.set(absolute, path);
      await mkdir(remoteDir, { recursive: true });
      if (ext === '.css') {
        const css = bytes.toString('utf8');
        const refs = cssRefs(css);
        const places = new Map<string, string | null>();
        for (const ref of refs) {
          if (/^(data|blob):/i.test(ref.url) || ref.url.startsWith('#')) continue;
          places.set(ref.raw, await bring(new URL(ref.url, absolute).href));
        }
        await writeFile(path, rewrite(css, refs, (ref) => (places.get(ref.raw) ? `./${basename(places.get(ref.raw)!)}` : null)));
      } else await writeFile(path, bytes);
      return path;
    } catch (err) {
      localized.delete(absolute);
      failed.set(absolute, err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  for (const file of [...files].sort()) {
    const to = join(dest, relative(root, file));
    await mkdir(dirname(to), { recursive: true });
    if (!isText(file)) {
      await copyFile(file, to);
      continue;
    }
    const text = await readFile(file, 'utf8');
    const refs = refsOf(file, text).filter((ref) => isRemote(ref.url));
    const places = new Map<string, string | null>();
    for (const ref of refs) places.set(ref.raw, await bring(ref.url));
    await writeFile(
      to,
      rewrite(text, refs, (ref) => {
        const place = places.get(ref.raw);
        return place ? relative(dirname(to), place).split(sep).join('/') : null;
      }),
    );
  }

  const show = (path: string) => relative(folder.root, path).split(sep).join('/');
  return {
    name,
    pages: sources.map((s) => show(join(dest, relative(root, s)))),
    copied: files.size,
    localized: [...localized].map(([url, path]) => ({ url, file: show(path) })),
    failed: [...failed].map(([url, error]) => ({ url, error })),
  };
}
