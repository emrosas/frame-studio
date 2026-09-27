// Checks the built app (ADR 0008): nothing named claude-agent-sdk- anywhere
// in it, app.asar included, the whole .app under 300 MB, and a code
// signature that verifies over the whole bundle. Run after npm run
// desktop:build, which runs it too. Exits non-zero on a failure.

import { spawnSync } from 'node:child_process';
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

const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' });

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(`${appPath}\n  ${mb(found.size)} (ceiling ${mb(CEILING)})\n  ${found.bad.length} paths named ${FORBIDDEN}\n  signature ${codesign.status === 0 ? 'valid' : 'invalid'}\n`);
let failed = false;
if (found.bad.length > 0) {
  process.stderr.write(`The app holds the Claude Agent SDK's bundled binary, which must stay out:\n${found.bad.slice(0, 10).join('\n')}\n`);
  failed = true;
}
if (found.size > CEILING) {
  process.stderr.write(`The app is ${mb(found.size)}, over the ${mb(CEILING)} ceiling.\n`);
  failed = true;
}
// A downloaded app whose signature doesn't verify is "damaged" to macOS, with no way to open it but the Terminal.
if (codesign.status !== 0) {
  process.stderr.write(`The app's code signature doesn't verify:\n${codesign.stderr || codesign.error?.message}\n`);
  failed = true;
}
process.exit(failed ? 1 : 0);
