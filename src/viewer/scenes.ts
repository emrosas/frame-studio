// Scene files, rigs and audio generators, validated. This module is the
// viewer's hot-swap boundary: main.ts accepts HMR updates for it, so editing
// any file in /scenes, any rig or any generator re-runs this module and the
// open viewer swaps the new library in place (same scene, same frame, same
// play state).
//
// Scenes are imported as raw text and parsed here so a malformed JSON file shows
// up as an error on that one scene instead of breaking the whole module graph.

import { createDefaultGenerators } from '../audio';
import { createRegistry, isRig, sceneGraphErrors, validateProject, validateScene, type Rig } from '../engine';
import { allRigs, createDefaultRegistry } from '../rigs';
import { buildLibrary, type SceneLibrary } from './library';

// Loose scenes, and every project's project.json and scenes (ADR 0007).
const files = import.meta.glob<string>(['/scenes/*.json', '/projects/*/*.json'], { eager: true, query: '?raw', import: 'default' });
// Each project's own rigs: every rig a module in projects/<id>/rigs/ exports.
const rigModules = import.meta.glob<Record<string, unknown>>('/projects/*/rigs/*.ts', { eager: true });

function projectRigs(): Record<string, Rig[]> {
  const out: Record<string, Rig[]> = {};
  for (const [path, mod] of Object.entries(rigModules)) {
    const project = /^\/projects\/([^/]+)\//.exec(path)?.[1];
    if (!project) continue;
    for (const value of Object.values(mod)) if (isRig(value) && !(out[project] ??= []).includes(value)) out[project].push(value);
  }
  return out;
}

export function loadLibrary(): SceneLibrary {
  return buildLibrary(files, validateScene, createDefaultRegistry, createDefaultGenerators, {
    validateProject,
    sceneGraphErrors,
    createProjectRegistry: (rigs) => createRegistry([...allRigs, ...rigs]),
    rigs: projectRigs(),
  });
}
