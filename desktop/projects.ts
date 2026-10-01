// Projects on screen (ADR 0013): what the switcher shows for each recent
// project, read from the project's own thread files, so it works whether or
// not the project's studio server runs. Electron main process only.

import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { displayStatus, normalizeRequest } from '../src/studio/protocol.ts';

/** A project's threads that need a look: working, waiting on the user's input, or the user's turn. */
export interface ProjectStatus {
  working: number;
  input: number;
  yours: number;
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
}

/** Counts a project's threads from .frame-studio/requests/. A folder without threads has none. */
export async function projectStatus(dir: string, now = Date.now()): Promise<ProjectStatus> {
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
          if (shown === 'input') out.input++;
          else if (thread.status === 'working') out.working++;
          else if (thread.status === 'your_turn') out.yours++;
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

/** The recent projects with their status, most recent first. */
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
        ...(exists ? await projectStatus(path) : { working: 0, input: 0, yours: 0, missing: true }),
      };
    }),
  );
}

/** Makes an empty project folder at `dir`. A folder with things in it is refused, so nothing is overwritten. */
export async function createProject(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => null);
  if (names && names.some((n) => !n.startsWith('.'))) return `${dir} already has files in it. Open it as a project instead.`;
  for (const sub of ['scenes', 'rigs', 'audio', 'media']) await mkdir(join(dir, sub), { recursive: true });
  return null;
}
