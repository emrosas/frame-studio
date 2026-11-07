// Finds a studio server for a folder, or starts one (ADR 0008). A running app
// or `npm run dev` writes .frame-studio/server.json with its address and
// token; a tool that finds a live server there reuses it, so an agent's
// renders and the viewer share one server and one render worker. Otherwise the
// tool starts a headless server of its own, with agents off, and a render
// worker in Electron when it needs one. A tool that may load the folder's code
// never reuses a server that won't (ADR 0017). server.json is only a hint, since
// it comes from the folder: it can name this computer and nothing else. Node only.

import { readFile, realpath } from 'node:fs/promises';
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
  /** The server leaves the folder's own code out. */
  untrusted: boolean;
  /** Stops the server this process started; leaves a reused one alone. */
  close(): Promise<void>;
}

const onThisComputer = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost');
  } catch {
    return false;
  }
};

/** The live server .frame-studio/server.json names for `folder`, or null. */
export async function liveServer(folder: StudioFolder): Promise<{ url: string; token: string; untrusted: boolean } | null> {
  let found: { url?: unknown; token?: unknown };
  try {
    found = JSON.parse(await readFile(join(folder.studio, 'server.json'), 'utf8')) as typeof found;
  } catch {
    return null;
  }
  if (typeof found.url !== 'string' || typeof found.token !== 'string' || !onThisComputer(found.url)) return null;
  try {
    const res = await fetch(`${found.url}/__studio/health`, { headers: { Authorization: `Bearer ${found.token}` }, signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { folder?: string; untrusted?: boolean };
    // By real path: a shell's working folder and the app's spelling of it differ across a link, and missing the app's server would mean leaving its trusted code out.
    const same = async (path: string) => realpath(path).catch(() => path);
    return typeof health.folder === 'string' && (await same(health.folder)) === (await same(folder.root)) ? { url: found.url, token: found.token, untrusted: health.untrusted === true } : null;
  } catch {
    return null;
  }
}

export async function connectStudio(
  folder: StudioFolder,
  options: { reuse?: boolean; viewer?: StudioServerOptions['viewer']; log?: (line: string) => void } = {},
): Promise<Connected> {
  const found = options.reuse === false ? null : await liveServer(folder);
  // A tool that may load the code needs a server that will. One without trust reuses anything: it asks for nothing more.
  const live = found && (found.untrusted ? folder.untrusted === true : true) ? found : null;
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
  return { url: server.url, token: server.token, transport: poolTransport(server.pool), server, untrusted: folder.untrusted === true, close: () => server.close() };
}
