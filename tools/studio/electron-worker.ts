// Starts a render worker without the app (ADR 0008): Electron in worker-only
// mode, a hidden window on render.html that connects back to this server. The
// CLI, the MCP shim and the tests use it; the app opens its own. Electron's
// Chromium is the pixel reference, so every render comes from the same build.
// Node only.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO } from './folder.ts';
import type { WorkerLauncher } from './render-pool.ts';

/** The Electron binary the repo installs. */
export function electronBinary(): string {
  const found = createRequire(import.meta.url)('electron') as unknown;
  if (typeof found !== 'string') throw new Error('Electron is not installed; run npm install.');
  return found;
}

/** An environment for a child that must not start as plain Node: Electron reads ELECTRON_RUN_AS_NODE. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function electronWorker(url: string, token: string, log: (line: string) => void): WorkerLauncher {
  return async () => {
    // The packaged app says which binary is itself (FRAME_STUDIO_ELECTRON); from the repo, it's the repo's Electron and main.
    const packaged = process.env.FRAME_STUDIO_ELECTRON;
    const child = spawn(packaged ?? electronBinary(), packaged ? ['--worker'] : [join(REPO, 'desktop/main.ts'), '--worker'], {
      env: childEnv(),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    // A missing binary is an error event; without a listener it would take the whole server down.
    await new Promise<void>((done, fail) => {
      child.once('spawn', () => done());
      child.once('error', fail);
    });
    child.on('error', (err) => log(`the render worker: ${err.message}`));
    // The address and token go over stdin, so neither shows in the process list.
    child.stdin?.end(`${JSON.stringify({ url, token })}\n`);
    const exited = new Promise<void>((done) => {
      child.once('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM') log(`the render worker exited (${code ?? signal}).${stderr ? `\n${stderr.trim()}` : ''}`);
        done();
      });
    });
    return {
      exited,
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      },
    };
  };
}
