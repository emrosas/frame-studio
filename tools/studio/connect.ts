// Finds a studio server for a folder, or starts one (ADR 0008). A running app
// or `npm run dev` writes .frame-studio/server.json with its address and
// token; a tool that finds a live server there reuses it, so an agent's
// renders and the viewer share one server and one render worker. Otherwise the
// tool starts a headless server of its own, with agents off, and a render
// worker in Electron when it needs one. Node only.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpTransport, poolTransport, type RenderTransport } from '../render/studio.ts';
import type { StudioFolder } from './folder.ts';
import { newToken } from './pairing.ts';
import { startStudioServer, type StudioServer, type StudioServerOptions } from './server.ts';

export interface Connected {
  url: string;
  token: string;
  transport: RenderTransport;
  /** The server this process started, or null when it reuses another. */
  server: StudioServer | null;
  /** Stops the server this process started; leaves a reused one alone. */
  close(): Promise<void>;
}

/** The live server .frame-studio/server.json names for `folder`, or null. */
export async function liveServer(folder: StudioFolder): Promise<{ url: string; token: string } | null> {
  let found: { url?: unknown; token?: unknown };
  try {
    found = JSON.parse(await readFile(join(folder.studio, 'server.json'), 'utf8')) as typeof found;
  } catch {
    return null;
  }
  if (typeof found.url !== 'string' || typeof found.token !== 'string') return null;
  try {
    const res = await fetch(`${found.url}/__studio/health`, { headers: { Authorization: `Bearer ${found.token}` }, signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { folder?: string };
    return health.folder === folder.root ? { url: found.url, token: found.token } : null;
  } catch {
    return null;
  }
}

export async function connectStudio(
  folder: StudioFolder,
  options: { reuse?: boolean; viewer?: StudioServerOptions['viewer']; log?: (line: string) => void } = {},
): Promise<Connected> {
  const live = options.reuse === false ? null : await liveServer(folder);
  if (live) return { ...live, transport: httpTransport(live.url, live.token), server: null, close: async () => {} };
  const server = await startStudioServer({
    folder,
    token: newToken(),
    port: 0,
    viewer: options.viewer ?? { kind: 'vite', hmr: false },
    agents: false,
    worker: 'electron',
    ...(options.log ? { log: options.log } : {}),
  });
  return { url: server.url, token: server.token, transport: poolTransport(server.pool), server, close: () => server.close() };
}
