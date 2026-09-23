import { activeOverride } from './overrides';
import { defaultParams } from './registry';
import { quantizeTime } from './time';
import { evaluateTracks } from './tracks';
import { BACKGROUND_ID, type Layer, type Params, type Rig, type RigRegistry, type Scene } from './types';

/** Everything a rig needs to draw one layer on one frame. */
export interface ResolvedLayer {
  id: string;
  rig: Rig;
  params: Params;
  t: number;
}

/** Draw order: background (if any) first, then scene.layers in array order. Index 0 is back-most. */
export function sceneLayers(scene: Scene): Layer[] {
  const layers: Layer[] = [];
  if (scene.background) layers.push({ ...scene.background, id: BACKGROUND_ID });
  layers.push(...scene.layers);
  return layers;
}

/**
 * Resolve a layer on an output frame.
 * t is the layer's quantized time (tracks are evaluated at it, so held frames hold).
 * The override is picked by output frame. Params: defaults < layer.params < tracks < override.params.
 */
export function resolveLayer(layer: Layer, scene: Scene, frame: number, registry: RigRegistry): ResolvedLayer {
  const t = quantizeTime(frame, scene.fps, layer.stepFps);
  const o = activeOverride(layer.overrides, frame);
  const rigId = o?.rig ?? layer.rig;
  const rig = registry.get(rigId);
  if (!rig) {
    const where = o?.rig !== undefined ? ` (override frames [${o.from}, ${o.to}))` : '';
    const known = [...registry.keys()].map((k) => `"${k}"`).join(', ') || '(none)';
    throw new Error(`layer "${layer.id}": rig "${rigId}"${where} is not registered; known rigs: ${known}`);
  }
  const params: Params = {
    ...defaultParams(rig),
    ...layer.params,
    ...evaluateTracks(layer.tracks, t),
    ...o?.params,
  };
  return { id: layer.id, rig, params, t };
}
