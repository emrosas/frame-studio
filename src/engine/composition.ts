// Compositions (ADR 0013): a project's edits. A composition arranges and
// never draws: tracks of clips, where a clip places a scene or another
// composition with a start, a trim and placement, plus sound cues and a
// background colour. Compositions nest as deep as wanted; a loop is an
// error. The engine renders one as a scene whose layers are its clips, bottom
// track first, so placement, masks, sound and hit testing are the scene
// layer's own (ADR 0007).

import { isVideoFile } from './picture';
import type { AudioCue, Layer, Marker, Override, Params, Scene, Track } from './types';
import { validateScene, type ProjectContext, type SchemaOwner, type ValidationResult } from './validate';
import type { RigRegistry } from './types';

/** A clip: a scene layer by another name. `scene` is a scene's or a composition's id. */
export interface Clip {
  id: string;
  /** A scene or composition to place. A clip has this or `file`. */
  scene?: string;
  /** An image or video in media/ (ADR 0014). `out` then says where the clip ends. */
  file?: string;
  fit?: 'cover' | 'contain';
  /** A video clip with its file's own sound. Default silent. */
  sound?: boolean;
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
  markers?: Marker[];
}

const COMPOSITION_FIELDS = ['id', 'fps', 'duration', 'size', 'seed', 'background', 'tracks', 'audio', 'markers'];
const TRACK_FIELDS = ['id', 'clips'];
const CLIP_FIELDS = ['id', 'scene', 'file', 'fit', 'sound', 'start', 'in', 'out', 'params', 'tracks', 'overrides', 'mask'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v));

/** A clip as the layer it renders as. `sound` becomes a cue. */
const clipLayer = (clip: Clip): Layer => {
  const { sound: _sound, ...layer } = clip;
  return layer as Layer;
};

/** The sound cues of a composition's video clips that keep their sound. */
function clipCues(tracks: readonly { clips?: unknown }[], duration: number): AudioCue[] {
  const clips = tracks.flatMap((t) => (Array.isArray(t.clips) ? (t.clips as Clip[]) : []));
  return clips.flatMap((c) => {
    if (c.sound !== true || typeof c.file !== 'string' || c.params?.mute === true) return [];
    const start = c.start ?? 0;
    const end = Math.min(duration, start + (c.out ?? 0) - (c.in ?? 0));
    if (!(end > start)) return [];
    // The clip's volume, as a value or keys, is the cue's. Keys are in composition seconds on both.
    // Runs before the validator has looked at the clip, so it takes nothing on trust.
    const volume = Array.isArray(c.tracks) ? c.tracks.filter((t) => t?.param === 'volume') : [];
    const fixed = typeof c.params?.volume === 'number' ? [{ param: 'volume', keys: [{ t: 0, v: c.params.volume }] }] : [];
    const tracks = volume.length > 0 ? volume : fixed;
    return [{ id: `${c.id}:sound`, file: c.file, start, end, in: c.in ?? 0, ...(tracks.length > 0 ? { tracks } : {}) }];
  });
}

/** The scene the engine renders for a composition: its clips as scene layers, its background as the fill rig. */
export function compositionToScene(c: Composition): Scene {
  const audio = [...(c.audio ?? []), ...clipCues(c.tracks, c.duration)];
  return {
    id: c.id,
    fps: c.fps,
    duration: c.duration,
    size: c.size,
    seed: c.seed ?? 0,
    ...(c.background !== undefined ? { background: { rig: 'fill', params: { color: c.background } } } : {}),
    layers: c.tracks.flatMap((t) => t.clips.map(clipLayer)),
    ...(audio.length > 0 ? { audio } : {}),
    ...(c.markers ? { markers: c.markers } : {}),
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
        if (clip.file === undefined && (typeof clip.scene !== 'string' || !clip.scene)) err(`${cp}.scene`, `must be the id of a scene or composition to place, or use "file" for an image or video in media/; got ${show(clip.scene)}`);
        if (clip.sound !== undefined && typeof clip.sound !== 'boolean') err(`${cp}.sound`, `must be true or false, got ${show(clip.sound)}`);
        if (clip.sound === true && (typeof clip.file !== 'string' || !isVideoFile(clip.file))) err(`${cp}.sound`, "keeps a video file's own sound; only a video clip takes it");
        if (clip.sound === true) {
          const tracks = Array.isArray(clip.tracks) ? (clip.tracks as { param?: unknown }[]) : [];
          const overrides = Array.isArray(clip.overrides) ? (clip.overrides as { params?: Record<string, unknown> }[]) : [];
          // These reach the picture, not the cue, so a video's sound would ignore them.
          if (tracks.some((t) => t.param === 'mute')) err(`${cp}.tracks`, 'a clip with sound: true takes keys on volume, not mute; key volume to 0');
          if (overrides.some((o) => o.params?.mute !== undefined || o.params?.volume !== undefined)) err(`${cp}.overrides`, 'a clip with sound: true takes volume as keys, not overrides; key volume in tracks');
        }
        places.push(cp);
        layers.push(clipLayer(clip as unknown as Clip));
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const fps = typeof input.fps === 'number' ? input.fps : NaN;
  const size = (Array.isArray(input.size) ? input.size : [0, 0]) as [number, number];
  const fromClips = Array.isArray(input.tracks) ? clipCues(input.tracks as { clips?: unknown }[], typeof input.duration === 'number' ? input.duration : Infinity) : [];
  const cuesIn = fromClips.length === 0 ? input.audio : [...(Array.isArray(input.audio) ? input.audio : []), ...fromClips];
  const scene = {
    id: input.id,
    fps: input.fps,
    duration: input.duration,
    size: input.size,
    seed: input.seed ?? 0,
    ...(input.background !== undefined ? { background: { rig: 'fill', params: { color: input.background } } } : {}),
    layers,
    ...(cuesIn !== undefined ? { audio: cuesIn } : {}),
    ...(input.markers !== undefined ? { markers: input.markers } : {}),
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
