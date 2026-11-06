// The projects in the sidebar (ADR 0013): what it shows for each recent
// project, read from the project's own files (its threads, videos, scenes and
// posters), so it works whether or not the project's studio server runs.
// Electron main process only.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_FORMAT, displayStatus, normalizeRequest } from '../src/studio/protocol.ts';

/** A project's threads that need a look: working, waiting on the user's input, or the user's turn. */
export interface ProjectStatus {
  working: number;
  input: number;
  yours: number;
}

/** A video or scene of a project whose server may not run. */
export interface ProjectItem {
  key: string;
  label: string;
  /** Relative to the project. */
  file: string;
  kind: 'scene' | 'composition';
  /** Its newest poster in .frame-studio/thumbs/, if it has one. */
  poster: string | null;
  /** The file doesn't parse. */
  invalid: boolean;
}

/** A film made before compositions, in projects/ (M9). */
export interface ProjectFilm {
  id: string;
  name: string;
  items: ProjectItem[];
}

export interface ProjectEntry extends ProjectStatus {
  path: string;
  name: string;
  /** The project on screen. */
  current: boolean;
  /** Its studio server runs, on screen or in the background. */
  open: boolean;
  /** The folder is gone. */
  missing?: boolean;
  /** Its videos, scenes and older films, read from disk. */
  videos: ProjectItem[];
  scenes: ProjectItem[];
  films: ProjectFilm[];
}

/** Parsed files, by path, so listing every few seconds only reads what changed. */
const parsed = new Map<string, { stamp: string; json: unknown }>();

/** A file's JSON, or undefined when it doesn't parse. */
async function readJson(path: string): Promise<unknown> {
  const info = await stat(path).catch(() => null);
  if (!info) return undefined;
  const stamp = `${info.mtimeMs}:${info.size}`;
  const known = parsed.get(path);
  if (known?.stamp === stamp) return known.json;
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Written just now, or broken: the row says so.
  }
  parsed.set(path, { stamp, json });
  return json;
}

const stemOf = (name: string) => name.slice(0, -'.json'.length);
const jsonNames = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
const slug = (key: string) => key.replace(/[^a-z0-9-]/gi, '_');

/** The newest poster of each slug, from thumbs/<slug>-<hash>.png. The hash stands for what the picture shows, so the newest is the one to show. */
async function newestPosters(dir: string): Promise<Map<string, string>> {
  const thumbs = join(dir, '.frame-studio', 'thumbs');
  const names = (await readdir(thumbs).catch(() => [] as string[])).filter((n) => POSTER_FILE.test(n));
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(thumbs, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = new Map<string, { name: string; at: number }>();
  for (const poster of dated) {
    const key = poster.name.slice(0, poster.name.lastIndexOf('-'));
    if (poster.at >= (newest.get(key)?.at ?? -1)) newest.set(key, poster);
  }
  return new Map([...newest].map(([key, poster]) => [key, poster.name]));
}

/** A poster's file name; anything else isn't one, so it can't climb out of thumbs/. */
export const POSTER_FILE = /^[a-z0-9_-]+-[0-9a-f]{12}\.png$/i;

/** A project's videos, scenes and older films, without its server. Keys match the viewer's for files that are in order. */
export async function projectContents(dir: string): Promise<Pick<ProjectEntry, 'videos' | 'scenes' | 'films'>> {
  const posters = await newestPosters(dir);
  const item = (key: string, label: string, file: string, kind: ProjectItem['kind'], invalid: boolean): ProjectItem => ({ key, label, file, kind, poster: posters.get(slug(key)) ?? null, invalid });

  const listed = await Promise.all(
    (await jsonNames(join(dir, 'scenes'))).map(async (name) => {
      const json = (await readJson(join(dir, 'scenes', name))) as { id?: unknown } | undefined;
      const key = typeof json?.id === 'string' && json.id.trim() !== '' ? json.id : stemOf(name);
      return item(key, key, `scenes/${name}`, 'scene', json === undefined);
    }),
  );
  // A Finder copy keeps its scene's id. As in the viewer's library, the file named after the id owns it; a copy lists under its path, as invalid.
  const stemOfScene = (i: ProjectItem) => stemOf(i.file.slice('scenes/'.length));
  const owned = new Set(listed.filter((i) => i.key === stemOfScene(i)).map((i) => i.key));
  const seen = new Set<string>();
  const scenes = listed.map((i) => {
    if (seen.has(i.key) || (owned.has(i.key) && stemOfScene(i) !== i.key)) return { ...i, key: i.file, label: stemOfScene(i), invalid: true };
    seen.add(i.key);
    return i;
  });
  const videos = await Promise.all(
    (await jsonNames(join(dir, 'compositions'))).map(async (name) => {
      const json = await readJson(join(dir, 'compositions', name));
      return item(stemOf(name), stemOf(name), `compositions/${name}`, 'composition', json === undefined);
    }),
  );
  const ids = (await readdir(join(dir, 'projects'), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const films = await Promise.all(
    ids.map(async (id): Promise<ProjectFilm | null> => {
      const names = (await jsonNames(join(dir, 'projects', id))).filter((n) => n !== 'project.json');
      if (names.length === 0) return null;
      const project = (await readJson(join(dir, 'projects', id, 'project.json'))) as { name?: unknown; main?: unknown } | undefined;
      const items = names.map((name) => item(`${id}/${stemOf(name)}`, stemOf(name), `projects/${id}/${name}`, 'scene', false));
      const main = typeof project?.main === 'string' ? `${id}/${project.main}` : null;
      items.sort((a, b) => Number(b.key === main) - Number(a.key === main));
      return { id, name: typeof project?.name === 'string' ? project.name : id, items };
    }),
  );
  return { videos, scenes, films: films.filter((f) => f !== null) };
}

/** A poster of a listed project as a data URL, for an <img> on another project's server. Null when there's none. */
export async function projectPoster(dir: string, file: string): Promise<string | null> {
  if (!POSTER_FILE.test(file)) return null;
  const bytes = await readFile(join(dir, '.frame-studio', 'thumbs', file)).catch(() => null);
  return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null;
}

/** How long a project just left keeps its server, and how many do, so going back takes under a second (ADR 0013). */
export const WARM_MS = 10 * 60 * 1000;
export const WARM_COUNT = 2;

/** Which projects in the background stay warm: the most recently left, for a while. */
export function warmProjects(left: ReadonlyMap<string, number>, now: number, ms = WARM_MS): Set<string> {
  const recent = [...left].filter(([, at]) => now - at < ms).sort(([, a], [, b]) => b - a);
  return new Set(recent.slice(0, WARM_COUNT).map(([folder]) => folder));
}

/**
 * Counts a project's threads from .frame-studio/requests/. A folder without
 * threads has none. A studio agent only works while its server runs, so with
 * none running a turn left working on disk says nothing about now.
 */
export async function projectStatus(dir: string, running = true, now = Date.now()): Promise<ProjectStatus> {
  const out: ProjectStatus = { working: 0, input: 0, yours: 0 };
  const requests = join(dir, '.frame-studio', 'requests');
  const names = await readdir(requests).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const thread = normalizeRequest(JSON.parse(await readFile(join(requests, n), 'utf8')));
          const shown = displayStatus(thread, now);
          const live = running || thread.agent === 'external';
          if (thread.status === 'your_turn') out.yours++;
          else if (live && shown === 'input') out.input++;
          else if (live && shown === 'working') out.working++;
        } catch {
          // A file being written, or not a thread: skip it.
        }
      }),
  );
  return out;
}

/** True while an agent the studio runs has a thread there working or waiting to start, so its server must keep running. */
export async function hasAgentWork(dir: string): Promise<boolean> {
  const requests = join(dir, '.frame-studio', 'requests');
  const names = await readdir(requests).catch(() => [] as string[]);
  for (const n of names.filter((x) => /^\d+\.json$/.test(x))) {
    try {
      const thread = normalizeRequest(JSON.parse(await readFile(join(requests, n), 'utf8')));
      if (thread.agent !== 'external' && (thread.status === 'working' || thread.status === 'pending')) return true;
    } catch {
      // skip
    }
  }
  return false;
}

/** The recent projects with their status and contents, most recent first. */
export async function listProjects(recent: readonly string[], current: string | null, open: ReadonlySet<string>): Promise<ProjectEntry[]> {
  return Promise.all(
    recent.map(async (path) => {
      const exists = await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      );
      return {
        path,
        name: basename(path),
        current: path === current,
        open: open.has(path),
        ...(exists ? await projectStatus(path, open.has(path)) : { working: 0, input: 0, yours: 0, missing: true }),
        ...(exists ? await projectContents(path) : { videos: [], scenes: [], films: [] }),
      };
    }),
  );
}

/** Makes an empty project folder at `dir`. A folder with things in it is refused, so nothing is overwritten. */
export async function createProject(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => null);
  if (names && names.some((n) => !n.startsWith('.'))) return `${dir} already has files in it. Open it as a project instead.`;
  for (const sub of ['scenes', 'compositions', 'rigs', 'audio', 'media']) await mkdir(join(dir, sub), { recursive: true });
  // The format new scenes and compositions start with, and a cast to fill in (ADR 0013).
  const project = { name: basename(dir), fps: DEFAULT_FORMAT.fps, size: DEFAULT_FORMAT.size, cast: {} };
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return null;
}
