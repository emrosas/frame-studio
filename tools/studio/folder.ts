// A studio folder (ADR 0008): the folder the studio works on, and where the
// built-in engine, rigs and generators come from. In the repo both are the
// repo, with src/ as the built-ins. In the app the folder is the user's and
// the built-ins ship read-only inside the app. Node only.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Approval } from './project-code.ts';

/** The repo this file sits in. */
export const REPO = resolve(import.meta.dirname, '../..');

export interface StudioFolder {
  /** The folder itself. */
  root: string;
  /** The built-in sources: engine/, rigs/, audio/ and embed/. The repo's src/ in the repo. */
  builtins: string;
  scenes: string;
  /** The project's compositions (ADR 0013). */
  compositions: string;
  projects: string;
  /** Rigs for every scene in the folder. */
  rigs: string;
  /** Sound generators for every scene in the folder. */
  audio: string;
  references: string;
  out: string;
  /** The handoff folder: the request queue, the selection, and server.json. */
  studio: string;
  /** Don't load the folder's own rigs and generators: the user opened it without trusting its code (ADR 0017). */
  untrusted?: boolean;
  /** What the user approved when the app asked; checked once, right before the code is first read (ADR 0017). */
  approval?: Approval;
}

const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Whether a server the app didn't start may load `root`'s code (ADR 0017): told to with --trust (`explicit`) or
 * FRAME_STUDIO_TRUST=1, or it's the repo itself. The app asks the user instead, and says which with its own flags.
 */
export function trustsCode(root: string, explicit = false): boolean {
  return explicit || process.env.FRAME_STUDIO_TRUST === '1' || realPath(root) === realPath(REPO);
}

/**
 * The folder at `root`. `builtins` defaults to the repo's src/, and `studio`
 * to FRAME_STUDIO_DIR or the folder's .frame-studio/, so tests never touch a
 * real queue.
 */
export function studioFolder(root: string = REPO, options: { builtins?: string; studio?: string; untrusted?: boolean; approval?: Approval } = {}): StudioFolder {
  const at = resolve(root);
  return {
    root: at,
    builtins: resolve(options.builtins ?? resolve(REPO, 'src')),
    scenes: resolve(at, 'scenes'),
    compositions: resolve(at, 'compositions'),
    projects: resolve(at, 'projects'),
    rigs: resolve(at, 'rigs'),
    audio: resolve(at, 'audio'),
    references: resolve(at, 'references'),
    out: resolve(at, 'out'),
    studio: resolve(options.studio ?? process.env.FRAME_STUDIO_DIR ?? resolve(at, '.frame-studio')),
    ...(options.untrusted ? { untrusted: true } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
  };
}
