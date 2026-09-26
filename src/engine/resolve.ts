import { activeOverride } from './overrides';
import { defaultParams } from './registry';
import { quantizeTime } from './time';
import { evaluateTracks } from './tracks';
import { BACKGROUND_ID, type Layer, type Params, type Rig, type RigRegistry, type Scene, type World } from './types';

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
 * Resolve a drawing layer on an output frame.
 * t is the layer's quantized time (tracks are evaluated at it, so held frames hold).
 * The override is picked by output frame. The rig is the override's, else the layer's, else its cast
 * member's. Params: defaults < cast member's params < layer.params < tracks < override.params.
 * A scene layer has no rig; see scene-layer.ts.
 */
export function resolveLayer(layer: Layer, scene: Scene, frame: number, registry: RigRegistry, world: World = {}): ResolvedLayer {
  if (layer.scene !== undefined) throw new Error(`layer "${layer.id}" places scene "${layer.scene}"; a scene layer has no rig`);
  const t = quantizeTime(frame, scene.fps, layer.stepFps);
  const o = activeOverride(layer.overrides, frame);
  const member = layer.cast !== undefined ? world.cast?.[layer.cast] : undefined;
  if (layer.cast !== undefined && !member) {
    throw new Error(`layer "${layer.id}": no cast member "${layer.cast}"${world.cast ? `; the cast is ${Object.keys(world.cast).join(', ') || 'empty'}` : ' (a loose scene has no cast)'}`);
  }
  const rigId = o?.rig ?? layer.rig ?? member?.rig ?? '';
  const rig = registry.get(rigId);
  if (!rig) {
    const where = o?.rig !== undefined ? ` (override frames [${o.from}, ${o.to}))` : '';
    const known = [...registry.keys()].map((k) => `"${k}"`).join(', ') || '(none)';
    throw new Error(`layer "${layer.id}": rig "${rigId}"${where} is not registered; known rigs: ${known}`);
  }
  const params: Params = {
    ...defaultParams(rig),
    ...member?.params,
    ...layer.params,
    ...evaluateTracks(layer.tracks, t),
    ...o?.params,
  };
  return { id: layer.id, rig, params, t };
}
