// Spoken words (ADR 0016). A file cue owns its words, in seconds into the file,
// so a cue moved or trimmed carries them. Here they become scene time, cut the
// way the cue plays: rigs read that through kit.speech, and keys and markers
// that name a word take their time from it. Pure, like everything the render
// reads: a word's time comes from the scene file and nothing else.

import { timeToFrame } from './time';
import type { AudioCue, DrawKit, Marker, Scene, SpokenWord, Track } from './types';

const SEPARATOR = '#';
const tidy = (t: number) => Math.round(t * 1e6) / 1e6;

/** "voice#w12", what a key or marker names a word with. */
export function wordRef(cueId: string, wordId: string): string {
  return `${cueId}${SEPARATOR}${wordId}`;
}

/** The cue and word a reference names, or null if it isn't shaped like one. A word id has no "#", so the last one divides them. */
export function parseWordRef(ref: string): { cue: string; word: string } | null {
  const at = ref.lastIndexOf(SEPARATOR);
  return at > 0 && at < ref.length - 1 ? { cue: ref.slice(0, at), word: ref.slice(at + 1) } : null;
}

/**
 * A cue's words in scene seconds. A cue plays from the frame its start lands on (src/audio/timing.ts), so its
 * words do too. Words outside what the trim plays go, and a word the trim cuts through stops at the cut.
 */
export function cueWords(cue: Pick<AudioCue, 'start' | 'end' | 'in' | 'words'>, fps: number): SpokenWord[] {
  const first = timeToFrame(cue.start, fps);
  const start = first / fps;
  const length = Math.max(first + 1, timeToFrame(cue.end, fps)) / fps - start;
  const from = cue.in ?? 0;
  return (cue.words ?? []).flatMap((word) => {
    const a = Math.max(word.start, from) - from;
    const b = Math.min(word.end, from + length) - from;
    return b <= a ? [] : [{ ...word, start: tidy(start + a), end: tidy(start + b) }];
  });
}

const memo = new WeakMap<Scene, Map<string, readonly SpokenWord[]>>();

/** cueWords by cue id, remembered per scene object, since rigs ask on every frame. Empty for an unknown cue. */
export function sceneWords(scene: Scene, cueId: string): readonly SpokenWord[] {
  let cues = memo.get(scene);
  if (!cues) memo.set(scene, (cues = new Map()));
  let words = cues.get(cueId);
  if (!words) {
    const cue = scene.audio?.find((c) => c.id === cueId) ?? scene.spoken?.find((c) => c.id === cueId);
    words = cue ? cueWords(cue, scene.fps) : [];
    cues.set(cueId, words);
  }
  return words;
}

/** Scene seconds where a referenced word starts, or null when it isn't there or the cue's trim cut it off. */
export function wordTime(scene: Scene, ref: string): number | null {
  const parsed = parseWordRef(ref);
  if (!parsed) return null;
  return sceneWords(scene, parsed.cue).find((w) => w.id === parsed.word)?.start ?? null;
}

/** `kit` with speech reading this scene, for the rig. A scene with no words keeps the kit it has. */
export function speechKit(kit: DrawKit, scene: Scene): DrawKit {
  if (!scene.spoken && !scene.audio?.some((cue) => cue.words)) return kit;
  return { part: (id, draw) => kit.part(id, draw), speech: (cueId) => sceneWords(scene, cueId) };
}

/** Every track a scene has that a word could land a key on. */
function sceneTracks(scene: Scene): { where: string; tracks: readonly Track[] }[] {
  const out: { where: string; tracks: readonly Track[] }[] = [];
  const add = (where: string, tracks: readonly Track[] | undefined) => {
    if (tracks) out.push({ where, tracks });
  };
  for (const layer of [...(scene.background ? [{ ...scene.background, id: 'background' }] : []), ...scene.layers]) {
    add(`layer "${layer.id}"`, layer.tracks);
    add(`mask of "${layer.id}"`, layer.mask?.tracks);
  }
  add('the camera', scene.camera?.tracks);
  for (const cue of scene.audio ?? []) add(`cue "${cue.id}"`, cue.tracks);
  return out;
}

function anchorTracks(scene: Scene, tracks: readonly Track[]): Track[] {
  return tracks.map((track) => {
    if (!track.keys.some((key) => key.word !== undefined)) return track;
    const keys = track.keys.map((key) => {
      const t = key.word !== undefined ? wordTime(scene, key.word) : null;
      return t === null ? key : { ...key, t };
    });
    // A word can move past a key that isn't anchored to it. Sorting is stable, so keys at one time keep their order.
    return { ...track, keys: keys.map((key, i) => ({ key, i })).sort((a, b) => a.key.t - b.key.t || a.i - b.i).map(({ key }) => key) };
  });
}

/**
 * The scene with every anchored key and marker at its word's time. The t in the file is only the last time
 * known, so an orphan stays where it was. Returns `scene` itself when nothing is anchored. Every scene a host
 * gets from the library has been through here.
 */
export function anchorWords(scene: Scene): Scene {
  const anchored = scene.markers?.some((m) => m.word !== undefined) || sceneTracks(scene).some(({ tracks }) => tracks.some((track) => track.keys.some((key) => key.word !== undefined)));
  if (!anchored) return scene;
  const out: Scene = { ...scene };
  const layer = <T extends { tracks?: Track[]; mask?: { tracks?: Track[] } }>(l: T): T => ({
    ...l,
    ...(l.tracks ? { tracks: anchorTracks(scene, l.tracks) } : {}),
    ...(l.mask?.tracks ? { mask: { ...l.mask, tracks: anchorTracks(scene, l.mask.tracks) } } : {}),
  });
  if (scene.background) out.background = layer(scene.background);
  out.layers = scene.layers.map(layer);
  if (scene.camera?.tracks) out.camera = { ...scene.camera, tracks: anchorTracks(scene, scene.camera.tracks) };
  if (scene.audio) out.audio = scene.audio.map((cue) => (cue.tracks ? { ...cue, tracks: anchorTracks(scene, cue.tracks) } : cue));
  if (scene.markers) {
    out.markers = scene.markers.map((m: Marker) => {
      const t = m.word !== undefined ? wordTime(scene, m.word) : null;
      return t === null ? m : { ...m, t };
    });
  }
  return out;
}

/** An anchor whose word is gone. */
export interface OrphanAnchor {
  /** What holds it, in words, like `layer "crystal", opacity`. */
  where: string;
  word: string;
  /** The time it keeps. */
  t: number;
}

/** Keys and markers naming a word the scene doesn't play: re-recorded away, or trimmed off. */
export function unanchoredWords(scene: Scene): OrphanAnchor[] {
  const out: OrphanAnchor[] = [];
  for (const { where, tracks } of sceneTracks(scene)) {
    for (const track of tracks) {
      for (const key of track.keys) if (key.word !== undefined && wordTime(scene, key.word) === null) out.push({ where: `${where}, ${track.param}`, word: key.word, t: key.t });
    }
  }
  for (const m of scene.markers ?? []) if (m.word !== undefined && wordTime(scene, m.word) === null) out.push({ where: `marker "${m.label}"`, word: m.word, t: m.t });
  return out;
}
