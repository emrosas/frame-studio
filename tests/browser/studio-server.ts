/**
 * Studio servers for the browser tests (ADR 0008): the repo as the studio
 * folder, Vite's dev middleware for the viewer, and a render worker in
 * Electron when a test renders. Each test file starts its own, on a free port,
 * and never writes .frame-studio/server.json, so a running `npm run dev` is
 * left alone.
 */
import { openStudio, poolTransport, type Studio } from '../../tools/render/studio';
import { ROOT } from '../../tools/scene-files';
import { studioFolder } from '../../tools/studio/folder';
import { newToken } from '../../tools/studio/pairing';
import { startStudioServer, type StudioServer } from '../../tools/studio/server';

export interface TestStudio {
  server: StudioServer;
  /** The server's URL with a trailing slash, as Vite's resolvedUrls gave it. */
  base: string;
  token: string;
  /** `base` + `path`, paired: the page trades the token for its cookie on load. */
  paired(path?: string): string;
  /** Headers for a tool's own requests. */
  auth: Record<string, string>;
  close(): Promise<void>;
}

export async function startStudio(options: { agents?: boolean; hmr?: boolean; folder?: string } = {}): Promise<TestStudio> {
  const token = newToken();
  const server = await startStudioServer({
    folder: studioFolder(options.folder ?? ROOT),
    token,
    port: 0,
    viewer: { kind: 'vite', hmr: options.hmr ?? false },
    agents: options.agents ?? false,
    worker: 'electron',
    log: () => {},
  });
  const base = `${server.url}/`;
  return {
    server,
    base,
    token,
    paired: (path = '') => `${base}${path}#token=${token}`,
    auth: { Authorization: `Bearer ${token}` },
    close: () => server.close(),
  };
}

/** A render client on `scene`, through a test server's render worker. */
export function renderClient(studio: TestStudio, scene: string): Promise<Studio> {
  return openStudio(scene, { transport: poolTransport(studio.server.pool) });
}
