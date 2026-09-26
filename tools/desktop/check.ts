// Checks the built app (ADR 0008): nothing named claude-agent-sdk- anywhere
// in it, app.asar included, and the whole .app under 300 MB. Run after
// npm run desktop:build, which runs it too. Exits non-zero on a failure.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listPackage } from '@electron/asar';
import { REPO } from '../studio/folder.ts';

const CEILING = 300 * 1024 * 1024;
const FORBIDDEN = 'claude-agent-sdk-';
const appPath = process.argv[2] ?? join(REPO, 'build/desktop/dist/mac-arm64/Frame Studio.app');

async function walk(dir: string, out: { size: number; bad: string[] }): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (path.includes(FORBIDDEN)) out.bad.push(path);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(path, out);
    else out.size += (await stat(path)).size;
  }
}

const found = { size: 0, bad: [] as string[] };
await walk(appPath, found);
const asar = join(appPath, 'Contents/Resources/app.asar');
const inAsar = listPackage(asar, { isPack: false }).filter((p) => p.includes(FORBIDDEN));
found.bad.push(...inAsar.map((p) => `${asar}:${p}`));

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(`${appPath}\n  ${mb(found.size)} (ceiling ${mb(CEILING)})\n  ${found.bad.length} paths named ${FORBIDDEN}\n`);
let failed = false;
if (found.bad.length > 0) {
  process.stderr.write(`The app holds the Claude Agent SDK's bundled binary, which must stay out:\n${found.bad.slice(0, 10).join('\n')}\n`);
  failed = true;
}
if (found.size > CEILING) {
  process.stderr.write(`The app is ${mb(found.size)}, over the ${mb(CEILING)} ceiling.\n`);
  failed = true;
}
process.exit(failed ? 1 : 0);
