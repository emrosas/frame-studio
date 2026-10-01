// A studio folder (ADR 0008): the folder the studio works on, and where the
// built-in engine, rigs and generators come from. In the repo both are the
// repo, with src/ as the built-ins. In the app the folder is the user's and
// the built-ins ship read-only inside the app. Node only.

import { resolve } from 'node:path';

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
}

/**
 * The folder at `root`. `builtins` defaults to the repo's src/, and `studio`
 * to FRAME_STUDIO_DIR or the folder's .frame-studio/, so tests never touch a
 * real queue.
 */
export function studioFolder(root: string = REPO, options: { builtins?: string; studio?: string } = {}): StudioFolder {
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
  };
}
