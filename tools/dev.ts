// npm run dev: the studio server on the repo, with Vite's dev middleware for
// the viewer's own code (ADR 0008). Scenes, projects, rigs and generators load
// through the server's file store and module service, as in the app. The
// pairing token stays the same across restarts (.frame-studio/dev-token), so a
// page paired once stays paired; the first visit needs the printed link.

import { join } from 'node:path';
import { REPO } from './studio/folder.ts';
import { installLoader } from './studio/loader.ts';

installLoader(join(REPO, 'src'));
const { chmod, mkdir, readFile, writeFile } = await import('node:fs/promises');
const { parseArgs } = await import('node:util');
const { studioFolder } = await import('./studio/folder.ts');
const { newToken } = await import('./studio/pairing.ts');
const { startStudioServer } = await import('./studio/server.ts');

const { values } = parseArgs({ options: { port: { type: 'string' }, folder: { type: 'string' } } });
const folder = studioFolder(values.folder ?? REPO);
await mkdir(folder.studio, { recursive: true });
const tokenFile = join(folder.studio, 'dev-token');
let token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
if (token.length < 16) {
  token = newToken();
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600).catch(() => {});
}

const server = await startStudioServer({
  folder,
  token,
  port: values.port ? Number(values.port) : 5173,
  viewer: { kind: 'vite' },
  agents: true,
  worker: 'electron',
  discovery: true,
});
process.stdout.write(`\n  Frame Studio on ${folder.root}\n  ${server.url}/#token=${token}\n\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
