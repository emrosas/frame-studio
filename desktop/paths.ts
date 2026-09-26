// Where the app finds its parts (ADR 0008). Run from the repo (npm run
// desktop), they're the repo's files; packaged, they sit in the app's
// Resources folder, outside app.asar, since Rolldown and Node's type
// stripping read them from disk. Electron main process only.

import { join, resolve } from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  /** The studio server's entry, run in a utility process. */
  server: string;
  /** The built viewer the server serves. */
  viewer: string;
  /** The built-in sources: engine/, rigs/, audio/, embed/. */
  builtins: string;
  /** What New studio folder copies: scenes/ and projects/. */
  samples: string;
  /** The desktop folder: preloads and the welcome page. */
  desktop: string;
  /** The Dock icon to set, run from the repo; null packaged, where the bundle has it. */
  dockIcon: string | null;
}

export function appPaths(): AppPaths {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      server: join(res, 'server/bin.mjs'),
      viewer: join(res, 'viewer'),
      builtins: join(res, 'builtins'),
      samples: join(res, 'samples'),
      desktop: join(app.getAppPath(), 'desktop'),
      dockIcon: null,
    };
  }
  const repo = resolve(import.meta.dirname, '..');
  return {
    server: join(repo, 'tools/studio/bin.ts'),
    viewer: join(repo, 'dist'),
    builtins: join(repo, 'src'),
    samples: repo,
    desktop: join(repo, 'desktop'),
    // Written by npm run desktop (tools/desktop/icon.ts).
    dockIcon: join(repo, 'build/desktop/icon.png'),
  };
}
