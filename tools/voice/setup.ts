// npm run voice:setup: builds the pinned whisper-cli for a run from the repo
// (ADR 0016). There's no prebuilt binary for macOS, so it fetches the checked
// source and builds it with cmake. tools/desktop/package.ts calls buildWhisper
// for the app. The model comes on first use, not here. Node only.

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devBinary, download, findWhisper, WHISPER_SOURCE, WHISPER_VERSION } from './whisper.ts';

function run(command: string, args: string[], cwd: string): void {
  const out = spawnSync(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
  if (out.error) throw new Error(`${command} isn't available: ${out.error.message}. voice:setup needs cmake and a C++ compiler.`);
  if (out.status !== 0) throw new Error(`${command} ${args.join(' ')} stopped with code ${out.status}.`);
}

/** Builds whisper-cli and copies it to `to`: one static file, with its Metal shaders inside. */
export async function buildWhisper(to: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-whisper-build-'));
  try {
    const archive = join(dir, 'source.tar.gz');
    process.stderr.write(`Fetching whisper.cpp ${WHISPER_VERSION}\n`);
    await download(WHISPER_SOURCE.url, archive, { sha256: WHISPER_SOURCE.sha256, bytes: 0 });
    run('tar', ['xzf', archive], dir);
    const source = join(dir, `whisper.cpp-${WHISPER_VERSION}`);
    process.stderr.write('Building whisper-cli\n');
    run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DGGML_METAL_EMBED_LIBRARY=ON'], source);
    run('cmake', ['--build', 'build', '-j', '8', '--target', 'whisper-cli'], source);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(source, 'build/bin/whisper-cli'), to);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = await findWhisper('');
  if (found) process.stderr.write(`whisper-cli ${WHISPER_VERSION} is at ${found}\n`);
  else {
    await buildWhisper(devBinary());
    process.stderr.write(`whisper-cli ${WHISPER_VERSION} is at ${devBinary()}\n`);
  }
}
