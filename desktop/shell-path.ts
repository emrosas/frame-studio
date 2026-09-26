// A GUI app on macOS starts with launchd's short PATH, not the one your
// terminal has, so `claude` and `codex` wouldn't be found (ADR 0008). Before
// anything starts, read PATH from the user's login shell, as T3 Code does,
// falling back to launchctl, and put it ahead of the inherited one. Electron
// main process only.

import { execFileSync } from 'node:child_process';
import { delimiter } from 'node:path';

const START = '__FRAME_STUDIO_PATH_START__';
const END = '__FRAME_STUDIO_PATH_END__';

function loginShellPath(): string | null {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', `printf '%s%s%s' '${START}' "$PATH" '${END}'`], {
      encoding: 'utf8',
      timeout: 5000,
      // Interactive shells ignore SIGTERM, so a hung profile would hold the launch without this.
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const at = out.lastIndexOf(START);
    const end = out.lastIndexOf(END);
    return at >= 0 && end > at ? out.slice(at + START.length, end) : null;
  } catch {
    return null;
  }
}

function launchctlPath(): string | null {
  try {
    return execFileSync('launchctl', ['getenv', 'PATH'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

/** Merges the login shell's PATH into this process's, first. Sets a locale when there is none. */
export function adoptShellPath(): void {
  if (process.platform === 'win32') return;
  const found = loginShellPath() ?? launchctlPath();
  if (found) {
    const seen = new Set<string>();
    process.env.PATH = [...found.split(delimiter), ...(process.env.PATH ?? '').split(delimiter)]
      .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
      .join(delimiter);
  }
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) process.env.LC_CTYPE = 'en_US.UTF-8';
}
