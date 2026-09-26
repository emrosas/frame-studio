/**
 * The repo's scene library, built straight from disk for unit tests: the
 * scene and project files, the built-in rigs and generators, and each
 * project's rigs, through Vite's import.meta.glob. The viewer and the tools
 * get the same library from the studio server (src/viewer/scenes.ts); this
 * builds it without one.
 */
import { createDefaultGenerators } from '../src/audio';
import { createRegistry, isRig, sceneGraphErrors, validateProject, validateScene, type Rig } from '../src/engine';
import { allRigs, createDefaultRegistry } from '../src/rigs';
import { buildLibrary, type SceneLibrary } from '../src/viewer/library';

const files = import.meta.glob<string>(['/scenes/*.json', '/projects/*/*.json'], { eager: true, query: '?raw', import: 'default' });
const rigModules = import.meta.glob<Record<string, unknown>>('/projects/*/rigs/**/*.ts', { eager: true });

function projectRigs(): Record<string, Rig[]> {
  const out: Record<string, Rig[]> = {};
  for (const [path, mod] of Object.entries(rigModules)) {
    const project = /^\/projects\/([^/]+)\//.exec(path)?.[1];
    if (!project) continue;
    for (const value of Object.values(mod)) if (isRig(value) && !(out[project] ??= []).includes(value)) out[project].push(value);
  }
  return out;
}

export function diskLibrary(): SceneLibrary {
  return buildLibrary(files, validateScene, createDefaultRegistry, createDefaultGenerators, {
    validateProject,
    sceneGraphErrors,
    createProjectRegistry: (rigs) => createRegistry([...allRigs, ...rigs]),
    rigs: projectRigs(),
  });
}
