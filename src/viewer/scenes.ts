// Scene files, rigs and audio generators, validated. This module is the
// viewer's hot-swap boundary: main.ts accepts HMR updates for it, so editing
// any file in /scenes, any rig or any generator re-runs this module and the
// open viewer swaps the new library in place (same scene, same frame, same
// play state).
//
// Scenes are imported as raw text and parsed here so a malformed JSON file shows
// up as an error on that one scene instead of breaking the whole module graph.

import { createDefaultGenerators } from '../audio';
import { validateScene } from '../engine';
import { createDefaultRegistry } from '../rigs';
import { buildLibrary, type SceneLibrary } from './library';

const files = import.meta.glob<string>('/scenes/*.json', { eager: true, query: '?raw', import: 'default' });

export function loadLibrary(): SceneLibrary {
  return buildLibrary(files, validateScene, createDefaultRegistry, createDefaultGenerators);
}
