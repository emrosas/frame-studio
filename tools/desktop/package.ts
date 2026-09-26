// npm run desktop:build: builds Frame Studio.app and a DMG for macOS arm64
// (ADR 0008), unsigned, into build/desktop/dist/. Then checks it
// (tools/desktop/check.ts). With --release it also builds the zip the
// updater downloads (ADR 0009); npm run desktop:release passes it.
//
// The stage, build/desktop/:
// - app/: what goes in app.asar. The main process bundled into main.mjs with
//   Rolldown, the preloads and the welcome page. No node_modules.
// - resources/: beside app.asar, since Rolldown and Node read them from disk.
//   server/ has the studio server and the MCP shim, each bundled into one file
//   with every JavaScript dependency inside, the Agent SDK included, so its
//   220 MB Claude binary never comes along; plus Rolldown, whose native
//   binding can't be bundled. viewer/ is the built viewer, builtins/ the
//   engine, rigs, generators and embed player as source, samples/ what New
//   studio folder copies, and bin/frame-studio-mcp the MCP command.

import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build as electronBuild } from 'electron-builder';
import { rolldown } from 'rolldown';
import { REPO } from '../studio/folder.ts';
import { writeIcon } from './icon.ts';

const STAGE = join(REPO, 'build/desktop');
const APP = join(STAGE, 'app');
const RES = join(STAGE, 'resources');
const OUT = join(STAGE, 'dist');

const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string; description: string };
const electronVersion = (JSON.parse(await readFile(join(REPO, 'node_modules/electron/package.json'), 'utf8')) as { version: string }).version;

function step(name: string): void {
  process.stderr.write(`${name}\n`);
}

/** Bundles `input` into one ES module at `file`, with everything but `external` inside. */
async function bundle(input: string, file: string, external: (string | RegExp)[]): Promise<void> {
  const build = await rolldown({ input, platform: 'node', external, logLevel: 'warn' });
  try {
    await build.write({ file, format: 'esm', codeSplitting: false, legalComments: 'none' });
  } finally {
    await build.close();
  }
}

step('viewer');
const vite = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: REPO, stdio: 'inherit' });
if (vite.status !== 0) process.exit(vite.status ?? 1);

await rm(STAGE, { recursive: true, force: true });
await mkdir(join(APP, 'desktop'), { recursive: true });
await mkdir(join(RES, 'server/node_modules/@rolldown'), { recursive: true });

step('icon');
const icon = await writeIcon(STAGE);

step('main process');
await bundle(join(REPO, 'desktop/main.ts'), join(APP, 'main.mjs'), ['electron']);
for (const file of ['preload.cjs', 'welcome-preload.cjs', 'welcome.html', 'welcome.js']) await cp(join(REPO, 'desktop', file), join(APP, 'desktop', file));
await writeFile(
  join(APP, 'package.json'),
  `${JSON.stringify({ name: 'frame-studio', productName: 'Frame Studio', version: pkg.version, description: pkg.description, main: 'main.mjs', type: 'module' }, null, 2)}\n`,
);

step('studio server and MCP shim');
// Rolldown ships beside them; Vite and Playwright are for the repo only, and the app never reaches them.
const serverExternal = ['electron', 'vite', 'playwright', /^rolldown(\/.*)?$/];
await bundle(join(REPO, 'tools/studio/bin.ts'), join(RES, 'server/bin.mjs'), serverExternal);
await bundle(join(REPO, 'tools/desktop/app-shim.ts'), join(RES, 'server/shim.mjs'), serverExternal);
await writeFile(join(RES, 'server/package.json'), '{ "type": "module" }\n');
for (const dep of ['rolldown', '@rolldown/binding-darwin-arm64', '@rolldown/pluginutils', '@oxc-project/types']) {
  await cp(join(REPO, 'node_modules', dep), join(RES, 'server/node_modules', dep), { recursive: true, dereference: true });
}

step('viewer, built-ins, samples');
await cp(join(REPO, 'dist'), join(RES, 'viewer'), { recursive: true });
const runtime = (src: string) => !/\.test\.ts$/.test(src) && !/[\\/]testing([\\/]|$)/.test(src);
for (const dir of ['engine', 'rigs', 'audio', 'embed']) await cp(join(REPO, 'src', dir), join(RES, 'builtins', dir), { recursive: true, filter: runtime });
await mkdir(join(RES, 'samples/scenes'), { recursive: true });
await cp(join(REPO, 'scenes/hello.json'), join(RES, 'samples/scenes/hello.json'));
await cp(join(REPO, 'projects/bears-story'), join(RES, 'samples/projects/bears-story'), { recursive: true });

step('frame-studio-mcp');
await mkdir(join(RES, 'bin'), { recursive: true });
const mcp = join(RES, 'bin/frame-studio-mcp');
await writeFile(
  mcp,
  `#!/bin/sh
# Frame Studio's MCP server for external agents. Register it with Claude Code from a studio folder:
#   claude mcp add frame-studio -- "/Applications/Frame Studio.app/Contents/Resources/bin/frame-studio-mcp"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTENTS="$(dirname "$(dirname "$HERE")")"
ELECTRON_RUN_AS_NODE=1 exec "$CONTENTS/MacOS/Frame Studio" "$CONTENTS/Resources/server/shim.mjs" "$@"
`,
);
await chmod(mcp, 0o755);

step('electron-builder');
// A release adds the zip the updater downloads. Its name, and the DMG's, are the ones the release feed lists.
const macTargets: ('dir' | 'dmg' | 'zip')[] = process.argv.includes('--release') ? ['dir', 'dmg', 'zip'] : ['dir', 'dmg'];
await electronBuild({
  targets: undefined,
  mac: macTargets,
  arm64: true,
  publish: 'never',
  config: {
    appId: 'studio.frame.app',
    productName: 'Frame Studio',
    copyright: 'Frame Studio contributors',
    electronVersion,
    electronDist: join(REPO, 'node_modules/electron/dist'),
    directories: { app: APP, output: OUT },
    // Nothing in the app needs a Node module installed, and the Agent SDK's platform binaries never belong in it.
    files: ['**/*', '!**/node_modules/**/*', '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*', '!**/*.map'],
    extraResources: [{ from: RES, to: '.', filter: ['**/*', '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*', '!**/*.map'] }],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    electronLanguages: ['en'],
    mac: {
      category: 'public.app-category.graphics-design',
      identity: null,
      hardenedRuntime: false,
      target: macTargets,
      icon: icon.icns ?? icon.png,
      artifactName: 'Frame-Studio-${version}-${arch}-mac.${ext}',
    },
    dmg: { title: 'Frame Studio', artifactName: 'Frame-Studio-${version}-${arch}.${ext}' },
  },
});

step('check');
const check = spawnSync(process.execPath, [join(REPO, 'tools/desktop/check.ts')], { stdio: 'inherit' });
process.exit(check.status ?? 1);
