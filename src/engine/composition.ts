// Compositions (ADR 0013): a project's edits. A composition arranges and
// never draws: tracks of clips, where a clip places a scene or another
// composition with a start, a trim and placement, plus sound cues and a
// background colour. Compositions nest as deep as wanted; a loop is an
// error. The engine renders one as a scene whose layers are its clips, bottom
// track first, so placement, masks, sound and hit testing are the scene
// layer's own (ADR 0007).

import type { AudioCue, Layer, Override, Params, Scene, Track } from './types';
import { validateScene, type ProjectContext, type SchemaOwner, type ValidationResult } from './validate';
import type { RigRegistry } from './types';

/** A clip: a scene layer by another name. `scene` is a scene's or a composition's id. */
export interface Clip {
  id: string;
  scene: string;
  start?: number;
  in?: number;
  out?: number;
  params?: Params;
  tracks?: Track[];
  overrides?: Override[];
  mask?: Layer['mask'];
}

export interface CompositionTrack {
  id: string;
  clips: Clip[];
}

export interface Composition {
  id: string;
  fps: number;
  duration: number;
  size: [number, number];
  /** Seeds the rigs its clips' masks draw with. Default 0. */
  seed?: number;
  /** A colour under every clip. Without it, the stage is clear, which an export shows as black. */
  background?: string;
  /** Bottom track first; within a track, later clips draw on top. */
  tracks: CompositionTrack[];
  audio?: AudioCue[];
}

const COMPOSITION_FIELDS = ['id', 'fps', 'duration', 'size', 'seed', 'background', 'tracks', 'audio'];
const TRACK_FIELDS = ['id', 'clips'];
const CLIP_FIELDS = ['id', 'scene', 'start', 'in', 'out', 'params', 'tracks', 'overrides', 'mask'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

/** The scene the engine renders for a composition: its clips as scene layers, its background as the fill rig. */
export function compositionToScene(c: Composition): Scene {
  return {
    id: c.id,
    fps: c.fps,
    duration: c.duration,
    size: c.size,
    seed: c.seed ?? 0,
    ...(c.background !== undefined ? { background: { rig: 'fill', params: { color: c.background } } } : {}),
    layers: c.tracks.flatMap((t) => t.clips.map((clip): Layer => ({ ...clip }))),
    ...(c.audio ? { audio: c.audio } : {}),
  };
}

export type CompositionValidation = { ok: true; composition: Composition; scene: Scene } | { ok: false; errors: string[] };

/**
 * Checks an untrusted composition. Its shape here; everything a clip and a cue can get wrong through the
 * scene validator, on the scene it renders as, with paths turned back into the composition's: layers[3]
 * becomes tracks[1].clips[0]. `context` is the project: its cast, and its scenes and compositions by id
 * with their lengths and fps.
 */
export function validateComposition(
  input: unknown,
  registry: RigRegistry | undefined,
  generators: ReadonlyMap<string, SchemaOwner> | undefined,
  context: Omit<ProjectContext, 'kind' | 'fps' | 'size'>,
): CompositionValidation {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`);
  if (!isObject(input)) return { ok: false, errors: [`composition: must be an object like { id, fps, duration, size, tracks }, got ${show(input)}`] };
  for (const key of Object.keys(input)) if (!COMPOSITION_FIELDS.includes(key)) err(key, `unknown field "${key}"; allowed fields: ${COMPOSITION_FIELDS.join(', ')}`);
  if (input.background !== undefined && typeof input.background !== 'string') err('background', `must be a colour, like "#101010", got ${show(input.background)}`);
  if (input.seed !== undefined && !(typeof input.seed === 'number' && Number.isInteger(input.seed))) err('seed', `must be an integer, got ${show(input.seed)}`);

  // Where each clip lands among the scene's layers, to turn paths back.
  const places: string[] = [];
  const layers: unknown[] = [];
  if (!Array.isArray(input.tracks)) {
    err('tracks', `must be a list of tracks like { "id": "V1", "clips": [...] }, bottom first, got ${show(input.tracks)}`);
  } else {
    const trackIds = new Map<string, number>();
    input.tracks.forEach((track: unknown, t: number) => {
      const tp = `tracks[${t}]`;
      if (!isObject(track)) {
        err(tp, `must be { "id": "V1", "clips": [...] }, got ${show(track)}`);
        return;
      }
      for (const key of Object.keys(track)) if (!TRACK_FIELDS.includes(key)) err(`${tp}.${key}`, `unknown field "${key}"; allowed fields: ${TRACK_FIELDS.join(', ')}`);
      if (typeof track.id !== 'string' || !track.id) err(`${tp}.id`, `must be a name, like "V1", got ${show(track.id)}`);
      else if (trackIds.has(track.id)) err(`${tp}.id`, `duplicate track id "${track.id}" (also tracks[${trackIds.get(track.id)}])`);
      else trackIds.set(track.id, t);
      if (!Array.isArray(track.clips)) {
        err(`${tp}.clips`, `must be a list of clips, got ${show(track.clips)}`);
        return;
      }
      track.clips.forEach((clip: unknown, c: number) => {
        const cp = `${tp}.clips[${c}]`;
        if (!isObject(clip)) {
          err(cp, `must be a clip like { "id": "intro", "scene": "intro", "start": 0 }, got ${show(clip)}`);
          return;
        }
        for (const key of Object.keys(clip)) if (!CLIP_FIELDS.includes(key)) err(`${cp}.${key}`, `unknown field "${key}"; a clip has ${CLIP_FIELDS.join(', ')}`);
        if (typeof clip.scene !== 'string' || !clip.scene) err(`${cp}.scene`, `must be the id of a scene or composition to place, got ${show(clip.scene)}`);
        places.push(cp);
        layers.push(clip);
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const fps = typeof input.fps === 'number' ? input.fps : NaN;
  const size = (Array.isArray(input.size) ? input.size : [0, 0]) as [number, number];
  const scene = {
    id: input.id,
    fps: input.fps,
    duration: input.duration,
    size: input.size,
    seed: input.seed ?? 0,
    ...(input.background !== undefined ? { background: { rig: 'fill', params: { color: input.background } } } : {}),
    layers,
    ...(input.audio !== undefined ? { audio: input.audio } : {}),
  };
  const result: ValidationResult = validateScene(scene, registry, generators, { ...context, fps, size, kind: 'composition' });
  if (!result.ok) {
    const back = (e: string) =>
      e
        .replace(/^layers\[(\d+)\]/, (_, i: string) => places[Number(i)] ?? `layers[${i}]`)
        .replace(/^layers:/, 'tracks:')
        .replace(/^background\.params\.color:/, 'background:')
        .replace(/^background(\.\w+)*:/, 'background:');
    return { ok: false, errors: result.errors.map(back) };
  }
  return { ok: true, composition: input as unknown as Composition, scene: result.scene };
}
