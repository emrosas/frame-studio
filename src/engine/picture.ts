// Picture clips (ADR 0014): a composition can place a recorded image or video
// from media/. Scenes stay drawn in code. Decoding is the host's job, like
// sound files: it reads what a frame needs from picturesAt, gets those ready,
// then render() takes them from world.pictures, synchronously.

import { MAX_SCENE_DEPTH, sceneLayerSpan, shotFrame } from './scene-layer';
import { frameCount, timeToFrame } from './time';
import type { Layer, Scene, World } from './types';

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
export const isImageFile = (file: string): boolean => IMAGE.test(file);
export const isVideoFile = (file: string): boolean => VIDEO.test(file);
export const isPictureFile = (file: string): boolean => isImageFile(file) || isVideoFile(file);

/** The second of the file a picture clip shows on this frame, or null when it isn't showing. An image's is always 0. */
export function pictureTime(layer: Layer, scene: Pick<Scene, 'fps' | 'duration'>, frame: number): number | null {
  const start = timeToFrame(layer.start ?? 0, scene.fps);
  const count = timeToFrame(layer.out ?? 0, scene.fps) - timeToFrame(layer.in ?? 0, scene.fps);
  if (frame < start || frame >= Math.min(frameCount(scene), start + count)) return null;
  if (isImageFile(layer.file ?? '')) return 0;
  return (layer.in ?? 0) + (frame - start) / scene.fps;
}

export interface PictureRequest {
  file: string;
  t: number;
}

/** Every picture this frame shows, its placed compositions' included. */
export function picturesAt(scene: Scene, frame: number, world: World = {}, depth = 0): PictureRequest[] {
  const out: PictureRequest[] = [];
  for (const layer of scene.layers) {
    if (layer.file !== undefined) {
      const t = pictureTime(layer, scene, frame);
      if (t !== null) out.push({ file: layer.file, t });
    } else if (layer.scene !== undefined && depth < MAX_SCENE_DEPTH) {
      const shot = world.scenes?.get(layer.scene);
      if (!shot) continue;
      const at = shotFrame(sceneLayerSpan(layer, scene, shot), frame);
      if (at !== null) out.push(...picturesAt(shot, at, world, depth + 1));
    }
  }
  return out;
}

/** Every picture file the scene uses at any frame, sorted. */
export function picturesUsed(scene: Scene, world: World = {}, depth = 0): string[] {
  const files = new Set<string>();
  for (const layer of scene.layers) {
    if (layer.file !== undefined) files.add(layer.file);
    else if (layer.scene !== undefined && depth < MAX_SCENE_DEPTH) {
      const shot = world.scenes?.get(layer.scene);
      if (shot) for (const f of picturesUsed(shot, world, depth + 1)) files.add(f);
    }
  }
  return [...files].sort();
}
