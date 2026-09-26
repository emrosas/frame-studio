// npm run desktop: builds the viewer, then runs the app from the repo with
// the repo's Electron (ADR 0008), with the app icon in the Dock. --no-build
// skips the viewer build. The app opens the last studio folder, or its
// welcome screen.

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { childEnv, electronBinary } from '../studio/electron-worker.ts';
import { REPO } from '../studio/folder.ts';
import { writeIcon } from './icon.ts';

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: REPO, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
// The Dock shows it in place of Electron's own (desktop/paths.ts).
await writeIcon(join(REPO, 'build/desktop'));
const child = spawn(electronBinary(), [join(REPO, 'desktop/main.ts')], { cwd: REPO, env: childEnv(), stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
