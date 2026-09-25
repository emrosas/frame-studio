// Finding and asking the user's installed CLIs, for provider status. Node only.

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** The first `name` on PATH that can run, or null. */
export async function findExecutable(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Runs a short command and returns what it printed on stdout, then stderr
 * (`codex login status` answers on stderr), or throws with its output.
 */
export function run(file: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(`${stdout}${stderr}`);
    });
  });
}
