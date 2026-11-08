// What the timeline does to a composition's or scene's file (ADR 0018): add,
// split, duplicate and delete clips and cues, move clips between tracks, trim
// and fade sound, and write transition presets. Pure work on the file's JSON,
// so the server checks the result like any other edit and undo restores it
// whole. Import-free, like the rest of src/studio, so Node uses it too.

type Json = Record<string, unknown>;
export type RawKey = { t: number; v: unknown; ease?: string; word?: string };
export type RawTrack = { param: string; keys: RawKey[] };
export type RawClip = Json & { id: string; start?: number; in?: number; out?: number; tracks?: RawTrack[]; overrides?: { from: number; to: number }[]; mask?: Json & { tracks?: RawTrack[] }; params?: Json };
export type RawCue = Json & { id: string; start: number; end: number; in?: number; fadeIn?: number; fadeOut?: number; file?: string; generator?: string; tracks?: RawTrack[]; words?: { id: string; start: number; end: number }[]; script?: string };
export interface TimelineFile {
  fps: number;
  duration: number;
  tracks?: { id: string; clips: RawClip[] }[];
  audio?: RawCue[];
}

export const TRANSITIONS = ['crossfade', 'wipe', 'iris'] as const;
export type Transition = (typeof TRANSITIONS)[number];
/** The mask rigs the presets write, and the side a wipe comes from. Ids of their own, so a studio's `iris` rig stays legal. */
export const TRANSITION_RIGS = { wipe: 'mask-wipe', iris: 'mask-iris' } as const;
const TRANSITION_EASE = 'inOutCubic';

/** A clip's place, in seconds: `out` null means the end of what it places. */
export interface ClipPlaceEdit {
  start: number;
  in: number;
  out: number | null;
}

export type TimelineEdit =
  /** `length` is the seconds of what it places, which the server reads. `track` null means the lowest with room. */
  | { op: 'add-clip'; source: { scene: string } | { file: string }; at: number; length: number; track: string | null }
  | { op: 'split-clip'; clip: string; at: number }
  | { op: 'duplicate-clip'; clip: string }
  | { op: 'delete-clip'; clip: string }
  | ({ op: 'move-clip'; clip: string; track: string } & ClipPlaceEdit)
  | { op: 'add-track' }
  | { op: 'delete-track'; track: string }
  | { op: 'edit-cue'; cue: string; start: number; end: number; in?: number; fadeIn?: number; fadeOut?: number }
  | { op: 'split-cue'; cue: string; at: number }
  | { op: 'duplicate-cue'; cue: string }
  | { op: 'delete-cue'; cue: string }
  /** `under` is the clip beneath: run on under a new transition as far as its material goes, or back when one comes off. `out` null is its end. */
  | { op: 'transition'; clip: string; preset: Transition | null; seconds: number; under?: { clip: string; out: number | null } | null };

/** What an edit made: the clip or cue to select afterwards. */
export interface TimelineResult {
  made?: string;
}

/** Clears float noise from a sum of times. Finer than the engine's frame tolerance, so a time stays on its frame. */
const round = (seconds: number) => Math.round(seconds * 1e12) / 1e12;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const seconds = (v: unknown) => isNum(v) && (v as number) >= 0;

/** Why `input` is not a well-formed TimelineEdit, or null. What it does to the file is the edit's and the validator's to say. */
export function checkTimelineEdit(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return 'a timeline edit must be a JSON object';
  const e = input as Json;
  const name = (v: unknown) => typeof v === 'string' && v !== '';
  switch (e.op) {
    case 'add-clip': {
      const source = e.source as Json | undefined;
      if (typeof source !== 'object' || source === null || (!name(source.scene) && !name(source.file))) return 'source must be { scene } or { file }';
      return seconds(e.at) ? null : 'at must be seconds, 0 or more';
    }
    case 'split-clip':
    case 'split-cue':
      if (!name(e.clip) && !name(e.cue)) return 'say which clip or cue';
      return seconds(e.at) ? null : 'at must be seconds, 0 or more';
    case 'duplicate-clip':
    case 'delete-clip':
      return name(e.clip) ? null : 'clip must be a clip id';
    case 'move-clip':
      if (!name(e.clip) || !name(e.track)) return 'move-clip takes a clip and a track';
      if (!seconds(e.start) || !seconds(e.in)) return 'start and in must be seconds, 0 or more';
      return e.out === null || (seconds(e.out) && (e.out as number) > (e.in as number)) ? null : 'out must be seconds after in, or null for the end';
    case 'add-track':
      return null;
    case 'delete-track':
      return name(e.track) ? null : 'track must be a track id';
    case 'edit-cue':
      if (!name(e.cue)) return 'cue must be a cue id';
      if (!seconds(e.start) || !seconds(e.end) || (e.end as number) <= (e.start as number)) return 'a cue needs seconds with start before end';
      for (const field of ['in', 'fadeIn', 'fadeOut']) if (e[field] !== undefined && !seconds(e[field])) return `${field} must be seconds, 0 or more`;
      return null;
    case 'duplicate-cue':
    case 'delete-cue':
      return name(e.cue) ? null : 'cue must be a cue id';
    case 'transition':
      if (!name(e.clip)) return 'clip must be a clip id';
      if (e.preset !== null && !TRANSITIONS.includes(e.preset as Transition)) return `preset must be ${TRANSITIONS.join(', ')} or null`;
      return seconds(e.seconds) && (e.preset === null || (e.seconds as number) > 0) ? null : 'seconds must be more than 0';
    default:
      return `unknown timeline edit "${String(e.op)}"`;
  }
}

/** Applies `edit` to `file` in place. Throws, in words for the person, when it can't be done. */
export function applyTimelineEdit(file: TimelineFile, edit: TimelineEdit, clipEnd: (clip: RawClip) => number | null = () => null): TimelineResult {
  switch (edit.op) {
    case 'add-clip':
      return addClip(file, edit, clipEnd);
    case 'split-clip':
      return splitClip(file, edit.clip, edit.at, clipEnd);
    case 'duplicate-clip':
      return duplicateClip(file, edit.clip, clipEnd);
    case 'delete-clip': {
      const { track, index } = findClip(file, edit.clip);
      track.clips.splice(index, 1);
      return {};
    }
    case 'move-clip': {
      const { track, index, clip } = findClip(file, edit.clip);
      const target = compositionTracks(file).find((t) => t.id === edit.track);
      if (!target) throw new Error(`There's no track "${edit.track}".`);
      placeClip(clip, edit, file);
      if (target !== track) {
        track.clips.splice(index, 1);
        target.clips.push(clip);
      }
      return { made: clip.id };
    }
    case 'add-track': {
      const tracks = compositionTracks(file);
      const made = freshTrack(tracks);
      tracks.push({ id: made, clips: [] });
      return { made };
    }
    case 'delete-track': {
      const tracks = compositionTracks(file);
      const at = tracks.findIndex((t) => t.id === edit.track);
      if (at < 0) throw new Error(`There's no track "${edit.track}".`);
      if (tracks[at].clips.length > 0) throw new Error(`Track ${edit.track} still has clips.`);
      if (tracks.length === 1) throw new Error('A video keeps at least one track.');
      tracks.splice(at, 1);
      return {};
    }
    case 'edit-cue':
      return editCue(file, edit);
    case 'split-cue':
      return splitCue(file, edit.cue, edit.at);
    case 'duplicate-cue':
      return duplicateCue(file, edit.cue);
    case 'delete-cue': {
      file.audio!.splice(findCue(file, edit.cue).index, 1);
      if (file.audio!.length === 0) delete file.audio;
      return {};
    }
    case 'transition':
      return setTransition(file, edit);
  }
}

function compositionTracks(file: TimelineFile): NonNullable<TimelineFile['tracks']> {
  if (!file.tracks) throw new Error('Clips and tracks are in videos. A scene has layers.');
  return file.tracks;
}

function findClip(file: TimelineFile, id: string) {
  for (const track of compositionTracks(file)) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, index, clip: track.clips[index] };
  }
  throw new Error(`There's no clip "${id}".`);
}

function findCue(file: TimelineFile, id: string) {
  const index = file.audio?.findIndex((c) => c.id === id) ?? -1;
  if (index < 0) throw new Error(`There's no sound "${id}". A video clip's own sound follows its clip.`);
  return { index, cue: file.audio![index] };
}

/** `stem`, or `stem-2` and on, so it takes none of `taken`. */
export function freshId(stem: string, taken: ReadonlySet<string>): string {
  const base = stem.replace(/-\d+$/, '') || stem;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function freshTrack(tracks: readonly { id: string }[]): string {
  const taken = new Set(tracks.map((t) => t.id));
  let n = tracks.length + 1;
  while (taken.has(`V${n}`)) n++;
  return `V${n}`;
}

const clipIds = (file: TimelineFile) => new Set(compositionTracks(file).flatMap((t) => t.clips.map((c) => c.id)));

function shiftTracks(list: RawTrack[] | undefined, by: number): void {
  // Below zero is fine: a key before the clip still shapes the curve into it.
  for (const track of list ?? []) for (const key of track.keys) key.t = round(key.t + by);
}

/** Keys and overrides are in composition time, so a fade goes where its clip goes. What slides off an end goes, as the clip's picture does. */
export function shiftClip(clip: RawClip, by: number, fps: number, duration: number): void {
  if (by === 0) return;
  shiftTracks(clip.tracks, by);
  shiftTracks(clip.mask?.tracks, by);
  if (clip.overrides) {
    const total = Math.floor(duration * fps + 1e-9);
    const delta = Math.round(by * fps);
    const place = (f: number) => Math.min(total, Math.max(0, f + delta));
    clip.overrides = clip.overrides.map((o) => ({ ...o, from: place(o.from), to: place(o.to) })).filter((o) => o.to > o.from);
    if (clip.overrides.length === 0) delete clip.overrides;
  }
}

/** Sets a clip's start and trim, leaving out what is the default. */
export function placeClip(clip: RawClip, place: ClipPlaceEdit, file: Pick<TimelineFile, 'fps' | 'duration'>): void {
  const moved = place.start - (clip.start ?? 0) - (place.in - (clip.in ?? 0));
  shiftClip(clip, moved, file.fps, file.duration);
  if (place.start > 0) clip.start = place.start;
  else delete clip.start;
  if (place.in > 0) clip.in = place.in;
  else delete clip.in;
  // A picture clip always says where it ends; the validator doesn't read files.
  if (place.out !== null) clip.out = place.out;
  else if (clip.file === undefined) delete clip.out;
}

/** Whether a span is clear of every clip on a track. */
const hasRoom = (file: TimelineFile, track: { clips: RawClip[] }, from: number, to: number, clipEnd: (clip: RawClip) => number | null) =>
  track.clips.every((c) => {
    const start = c.start ?? 0;
    const end = clipEnd(c) ?? (c.out !== undefined ? start + c.out - (c.in ?? 0) : file.duration);
    return end <= from + 1e-9 || start >= to - 1e-9;
  });

function addClip(file: TimelineFile, edit: Extract<TimelineEdit, { op: 'add-clip' }>, clipEnd: (clip: RawClip) => number | null): TimelineResult {
  const tracks = compositionTracks(file);
  const end = round(edit.at + edit.length);
  const preferred = tracks.find((t) => t.id === edit.track);
  const track =
    (preferred && hasRoom(file, preferred, edit.at, end, clipEnd) ? preferred : undefined) ??
    tracks.find((t) => hasRoom(file, t, edit.at, end, clipEnd)) ??
    (() => {
      const made = { id: freshTrack(tracks), clips: [] as RawClip[] };
      tracks.push(made);
      return made;
    })();
  const stem = 'scene' in edit.source ? edit.source.scene : edit.source.file.slice(edit.source.file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const id = freshId(stem.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'clip', clipIds(file));
  const clip: RawClip = { id, ...edit.source, ...(edit.at > 0 ? { start: edit.at } : {}), ...('file' in edit.source ? { out: edit.length } : {}) };
  track.clips.push(clip);
  // A video grows to hold what's put on it.
  if (end > file.duration) file.duration = end;
  return { made: id };
}

/** Each half keeps the keys inside it, and the nearest on either side, so the curve through the cut stays exactly as it was. */
function keepKeys(track: RawTrack, from: number, to: number): RawTrack {
  let first = 0;
  let last = track.keys.length - 1;
  track.keys.forEach((key, i) => {
    if (key.t <= from + 1e-9) first = i;
  });
  for (let i = track.keys.length - 1; i >= 0; i--) if (track.keys[i].t >= to - 1e-9) last = i;
  return { ...track, keys: track.keys.slice(first, Math.max(first, last) + 1) };
}

function halfOf(clip: RawClip, from: number, to: number, fps: number): RawClip {
  const half = structuredClone(clip);
  if (half.tracks) half.tracks = half.tracks.map((t) => keepKeys(t, from, to));
  if (half.mask?.tracks) half.mask.tracks = half.mask.tracks.map((t) => keepKeys(t, from, to));
  if (half.overrides) {
    const a = Math.round(from * fps);
    const b = Math.round(to * fps);
    half.overrides = half.overrides.map((o) => ({ ...o, from: Math.max(a, o.from), to: Math.min(b, o.to) })).filter((o) => o.to > o.from);
    if (half.overrides.length === 0) delete half.overrides;
  }
  return half;
}

function splitClip(file: TimelineFile, id: string, at: number, clipEnd: (clip: RawClip) => number | null): TimelineResult {
  const { track, index, clip } = findClip(file, id);
  const start = clip.start ?? 0;
  const end = clipEnd(clip) ?? (clip.out !== undefined ? start + clip.out - (clip.in ?? 0) : null);
  if (at <= start + 1e-9 || (end !== null && at >= end - 1e-9)) throw new Error(`Put the playhead inside "${id}" to split it.`);
  // In frames, as the engine reads it, so a clip that starts between frames still meets at the cut.
  const frame = (t: number) => Math.floor(t * file.fps + 1e-9);
  const cut = (frame(clip.in ?? 0) + frame(at) - frame(start)) / file.fps;
  const left = halfOf(clip, start, at, file.fps);
  const right = halfOf(clip, at, end ?? file.duration, file.fps);
  left.out = cut;
  right.id = freshId(id, clipIds(file));
  right.start = at;
  right.in = cut;
  track.clips.splice(index, 1, left, right);
  return { made: right.id };
}

function duplicateClip(file: TimelineFile, id: string, clipEnd: (clip: RawClip) => number | null): TimelineResult {
  const { track, index, clip } = findClip(file, id);
  const start = clip.start ?? 0;
  const end = clipEnd(clip) ?? (clip.out !== undefined ? start + clip.out - (clip.in ?? 0) : null);
  if (end === null) throw new Error(`"${id}" has no known length to duplicate.`);
  const copy = structuredClone(clip);
  copy.id = freshId(id, clipIds(file));
  copy.start = round(end);
  const length = end - start;
  if (end + length > file.duration) file.duration = round(end + length);
  shiftClip(copy, length, file.fps, file.duration);
  track.clips.splice(index + 1, 0, copy);
  return { made: copy.id };
}

function editCue(file: TimelineFile, edit: Extract<TimelineEdit, { op: 'edit-cue' }>): TimelineResult {
  const { cue } = findCue(file, edit.cue);
  const from = edit.in ?? cue.in ?? 0;
  // Volume keys are in the scene's seconds, so they go where the sound goes. A trim leaves them.
  shiftTracks(cue.tracks, edit.start - cue.start - (from - (cue.in ?? 0)));
  cue.start = edit.start;
  cue.end = edit.end;
  const set = (field: 'in' | 'fadeIn' | 'fadeOut', value: number | undefined) => {
    if (value === undefined) return;
    if (value > 0) cue[field] = value;
    else delete cue[field];
  };
  set('in', cue.file !== undefined ? edit.in : undefined);
  const length = edit.end - edit.start;
  set('fadeIn', edit.fadeIn === undefined ? undefined : Math.min(edit.fadeIn, length));
  set('fadeOut', edit.fadeOut === undefined ? undefined : Math.min(edit.fadeOut, length));
  return {};
}

const cueIds = (file: TimelineFile) => new Set((file.audio ?? []).map((c) => c.id));

/** Whether a rig's `cue` param or a word anchor in the file names this cue. */
function readsCue(file: TimelineFile, id: string): boolean {
  const text = JSON.stringify(file);
  return text.includes(`"cue":${JSON.stringify(id)}`) || text.includes(`"word":${JSON.stringify(`${id}#`).slice(0, -1)}`);
}

function splitCue(file: TimelineFile, id: string, at: number): TimelineResult {
  const { index, cue } = findCue(file, id);
  if (cue.file === undefined) throw new Error(`"${id}" is generated, and a generator starts over at a cut. Trim it instead.`);
  if (at <= cue.start + 1e-9 || at >= cue.end - 1e-9) throw new Error(`Put the playhead inside "${id}" to split it.`);
  if (readsCue(file, id)) throw new Error(`Captions or word anchors read "${id}", and a split would cut them off at the join. Trim it instead.`);
  if (at - cue.start < (cue.fadeIn ?? 0) - 1e-9 || cue.end - at < (cue.fadeOut ?? 0) - 1e-9) throw new Error(`The playhead is inside a fade on "${id}", which a split would change. Split outside it, or shorten the fade first.`);
  const frame = (t: number) => Math.floor(t * file.fps + 1e-9);
  const cut = round((cue.in ?? 0) + (frame(at) - frame(cue.start)) / file.fps);
  const left = structuredClone(cue);
  const right = structuredClone(cue);
  left.end = at;
  delete left.fadeOut;
  right.id = freshId(id, cueIds(file));
  right.start = at;
  right.in = cut;
  delete right.fadeIn;
  // Words belong to the half that says them, and the script no longer matches either half.
  if (cue.words) {
    left.words = cue.words.filter((w) => w.start < cut);
    right.words = cue.words.filter((w) => w.start >= cut);
    for (const half of [left, right]) if (half.words?.length === 0) delete half.words;
    delete left.script;
    delete right.script;
  }
  file.audio!.splice(index, 1, left, right);
  return { made: right.id };
}

function duplicateCue(file: TimelineFile, id: string): TimelineResult {
  const { index, cue } = findCue(file, id);
  const length = cue.end - cue.start;
  const start = cue.end;
  let end = round(start + length);
  if (end > file.duration) {
    // A video grows; a scene's length is its drawing's, so the copy stops at the end.
    if (file.tracks) file.duration = end;
    else end = file.duration;
  }
  if (end <= start + 1e-9) throw new Error(`"${id}" ends where the scene does, so there's no room for a copy after it.`);
  const copy = structuredClone(cue);
  copy.id = freshId(id, cueIds(file));
  copy.start = round(start);
  copy.end = end;
  shiftTracks(copy.tracks, length);
  file.audio!.splice(index + 1, 0, copy);
  return { made: copy.id };
}

/** How long the preset on a clip runs, in seconds, or null without one. */
export function transitionSeconds(clip: RawClip): number | null {
  const start = clip.start ?? 0;
  const keys = (typeof clip.mask?.rig === 'string' && (Object.values(TRANSITION_RIGS) as string[]).includes(clip.mask.rig) ? clip.mask.tracks?.[0] : clip.tracks?.find((t) => t.param === 'opacity'))?.keys;
  return keys && keys.length >= 2 && Math.abs(keys[0].t - start) < 1e-6 && keys[0].v === 0 && keys[1].ease === TRANSITION_EASE ? keys[1].t - keys[0].t : null;
}

/** Takes off what a preset wrote, leaving any other opacity keys and masks an agent gave the clip. */
function clearTransition(clip: RawClip): void {
  if (typeof clip.mask?.rig === 'string' && (Object.values(TRANSITION_RIGS) as string[]).includes(clip.mask.rig)) delete clip.mask;
  const at = clip.tracks?.findIndex((t) => t.param === 'opacity') ?? -1;
  if (at < 0) return;
  const start = clip.start ?? 0;
  const track = clip.tracks![at];
  if (track.keys.length >= 2 && Math.abs(track.keys[0].t - start) < 1e-6 && track.keys[0].v === 0 && track.keys[1].ease === TRANSITION_EASE) track.keys.splice(0, 2);
  if (track.keys.length === 0) clip.tracks!.splice(at, 1);
  if (clip.tracks!.length === 0) delete clip.tracks;
}

function setTransition(file: TimelineFile, edit: Extract<TimelineEdit, { op: 'transition' }>): TimelineResult {
  const { clip } = findClip(file, edit.clip);
  clearTransition(clip);
  if (edit.under) {
    const under = findClip(file, edit.under.clip).clip;
    if (edit.under.out === null) delete under.out;
    else under.out = round(edit.under.out);
  }
  if (edit.preset === null) return { made: clip.id };
  const from = clip.start ?? 0;
  const to = round(from + edit.seconds);
  if (edit.preset === 'crossfade') {
    clip.tracks ??= [];
    const track = clip.tracks.find((t) => t.param === 'opacity');
    const full = typeof clip.params?.opacity === 'number' ? clip.params.opacity : 1;
    const keys: RawKey[] = [{ t: from, v: 0 }, { t: to, v: full, ease: TRANSITION_EASE }];
    if (track) track.keys = [...keys, ...track.keys.filter((k) => k.t > to + 1e-9)];
    else clip.tracks.push({ param: 'opacity', keys });
  } else {
    if (clip.mask) throw new Error(`"${clip.id}" already has a mask. Ask the agent to change it, or use a crossfade.`);
    clip.mask = {
      rig: TRANSITION_RIGS[edit.preset],
      tracks: [{ param: 'progress', keys: [{ t: from, v: 0 }, { t: to, v: 1, ease: TRANSITION_EASE }] }],
    };
  }
  return { made: clip.id };
}
