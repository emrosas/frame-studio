// Undo for clip edits on the timeline, and nothing else: two stacks of moves
// on one composition. A save comes back as a changed file a moment later,
// possibly after the next save has answered, so the history can't go by the
// order of events. It goes by content instead: a clip may only land where one
// of our saves put it, and everything else in the file must stay as it was.
// Any other change (an agent's edit, a hand edit) ends the history, since the
// inverse of a move is no longer known to be right. Pure, so it is unit tested
// without a browser.

import type { Layer, Scene } from '../engine/types';
import type { ClipPlace } from './timeline';

export interface ClipEdit {
  layerId: string;
  before: ClipPlace;
  after: ClipPlace;
}

/** What a composition holds, for telling our saves from anyone else's edit. */
export interface ClipState {
  /** Everything a clip move leaves alone. A move carries a clip's keys and overrides along, so they count relative to the clip. */
  shape: string;
  /** Each clip's start, in and out, as clipPlaceKey writes them. */
  places: ReadonlyMap<string, string>;
}

/** A clip's place in the file's seconds. No `out` means the end of what it places. */
export function clipPlaceKey(start: number, inPoint: number, out: number | null | undefined): string {
  return `${start}/${inPoint}/${out ?? ''}`;
}

const tidy = (t: number) => Math.round(t * 1e6) / 1e6;

export function clipState(scene: Scene): ClipState {
  const places = new Map<string, string>();
  const shifted = (tracks: Layer['tracks'], by: number) => tracks?.map((track) => ({ ...track, keys: track.keys.map((key) => ({ ...key, t: tidy(key.t - by) })) }));
  const layers = scene.layers.map((layer) => {
    const { start = 0, in: inPoint = 0, out, ...rest } = layer;
    places.set(layer.id, clipPlaceKey(start, inPoint, out));
    const by = start - inPoint;
    const frames = Math.round(by * scene.fps);
    return {
      ...rest,
      ...(rest.tracks ? { tracks: shifted(rest.tracks, by) } : {}),
      ...(rest.mask?.tracks ? { mask: { ...rest.mask, tracks: shifted(rest.mask.tracks, by) } } : {}),
      ...(rest.overrides ? { overrides: rest.overrides.map((o) => ({ ...o, from: o.from - frames, to: o.to - frames })) } : {}),
    };
  });
  // A video clip's own sound is a cue that moves with it.
  const audio = scene.audio?.filter((cue) => !places.has(cue.id.replace(/:sound$/, '')));
  return { shape: JSON.stringify({ ...scene, layers, audio }), places };
}

export class ClipHistory {
  private done: ClipEdit[] = [];
  private undone: ClipEdit[] = [];
  private key: string | null = null;
  private state: ClipState | null = null;
  /** Where our saves have put clips, "layer|place". */
  private saved = new Set<string>();

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.saved.clear();
  }

  /** A save of ours is about to put a clip here. */
  saving(layerId: string, place: string): void {
    this.saved.add(`${layerId}|${place}`);
  }

  /** A new edit: it can be undone, and what was undone before it can't come back. */
  record(edit: ClipEdit): void {
    this.done.push(edit);
    this.undone = [];
  }

  /** Takes the newest edit to apply its `before`, or null. */
  undo(): ClipEdit | null {
    const edit = this.done.pop() ?? null;
    if (edit) this.undone.push(edit);
    return edit;
  }

  /** Takes the newest undone edit to apply its `after`, or null. */
  redo(): ClipEdit | null {
    const edit = this.undone.pop() ?? null;
    if (edit) this.done.push(edit);
    return edit;
  }

  /** What is on screen now. Another composition, or a change our saves don't explain, ends the history. */
  sync(key: string | null, state: ClipState | null): void {
    const before = this.state;
    if (key !== this.key || !state || !before || state.shape !== before.shape) this.clear();
    else {
      for (const [id, place] of state.places) {
        if (place !== before.places.get(id) && !this.saved.has(`${id}|${place}`)) this.clear();
      }
    }
    this.key = key;
    this.state = state;
  }
}
