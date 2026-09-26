// Runs a studio server on its own (ADR 0008): the app starts this in a
// utility process, and it works from a terminal too.
//
//   node tools/studio/bin.ts --folder <studio folder> --viewer <built viewer dir>
//     [--builtins <dir>] [--port 4753] [--agents] [--worker app|electron] [--discovery]
//
// The pairing token never goes on the command line. In a utility process it
// comes as the first message from the parent, which gets { url } back once
// the server listens. From a terminal it's the first line of stdin.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './folder.ts';
import { installLoader } from './loader.ts';

const { values } = parseArgs({
  options: {
    folder: { type: 'string' },
    viewer: { type: 'string' },
    builtins: { type: 'string' },
    port: { type: 'string' },
    agents: { type: 'boolean' },
    worker: { type: 'string' },
    discovery: { type: 'boolean' },
  },
});
const builtins = resolve(values.builtins ?? resolve(REPO, 'src'));
installLoader(builtins);
const { studioFolder } = await import('./folder.ts');
const { startStudioServer } = await import('./server.ts');

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;

async function readToken(): Promise<string> {
  if (parent) {
    return new Promise((done) => parent.on('message', (e) => done(String((e.data as { token?: unknown }).token ?? ''))));
  }
  let text = '';
  for await (const chunk of process.stdin) {
    text += (chunk as Buffer).toString();
    if (text.includes('\n')) break;
  }
  return text.trim();
}

if (!values.folder || !values.viewer) {
  process.stderr.write('Usage: node tools/studio/bin.ts --folder <studio folder> --viewer <built viewer dir> [--builtins <dir>] [--port <n>] [--agents] [--worker app|electron] [--discovery]\n');
  process.exit(2);
}
const token = await readToken();
const server = await startStudioServer({
  folder: studioFolder(values.folder, { builtins }),
  token,
  port: values.port ? Number(values.port) : undefined,
  viewer: { kind: 'static', dir: values.viewer },
  agents: values.agents ?? false,
  worker: values.worker === 'electron' ? 'electron' : 'app',
  discovery: values.discovery ?? false,
});
if (parent) parent.postMessage({ url: server.url });
else process.stdout.write(`${server.url}\n`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
