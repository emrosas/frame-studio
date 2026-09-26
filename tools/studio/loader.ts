// Lets Node load the studio's TypeScript the way the viewer's bundler does
// (ADR 0008): relative imports without an extension, index.ts folders, and
// the @frame-studio/ names for the built-ins. Node strips the types itself.
// A version query on a module's URL passes to everything it imports, so
// loading a rig again under a new version reloads its whole graph.
//
// Install it first thing in every entry point that runs from source, before
// importing anything under src/. Its own imports are Node built-ins only.
// Node only.

import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let installed: string | null = null;

/** The file a path names: itself, with .ts, or its index.ts. Null when none exists. */
export function findSource(path: string): string | null {
  for (const candidate of [path, `${path}.ts`, join(path, 'index.ts')]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable: try the next
    }
  }
  return null;
}

/** Installs the resolve hook once per process, mapping @frame-studio/ to `builtins`. */
export function installLoader(builtins: string): void {
  const root = resolve(builtins);
  if (installed !== null) {
    if (installed !== root) throw new Error(`The studio loader already maps @frame-studio/ to ${installed}.`);
    return;
  }
  installed = root;
  // stripTypeScriptTypes and .ts loading still warn as experimental; the studio relies on them on purpose.
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/Type Stripping|stripTypeScriptTypes/i.test(text)) return;
    (emit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL;
      const named = /^@frame-studio\/(.+)$/.exec(specifier);
      let path: string | null = null;
      if (named) path = join(root, named[1]);
      else if ((specifier.startsWith('./') || specifier.startsWith('../')) && parent?.startsWith('file:')) {
        path = fileURLToPath(new URL(specifier, parent));
      }
      const found = path !== null ? findSource(path) : null;
      if (found === null || !found.endsWith('.ts')) return next(specifier, context);
      const url = pathToFileURL(found);
      if (parent?.startsWith('file:')) url.search = new URL(parent).search;
      return { url: url.href, format: 'module-typescript', shortCircuit: true };
    },
  });
}
