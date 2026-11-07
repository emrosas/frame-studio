// Undo for hand edits: key edits and canvas drags on any scene, clips on a
// composition, in one stack (ADR 0015). Each entry holds the layer's JSON
// before and after, as the server read it from the file, so taking one back
// restores everything the edit touched, an override a clip move pushed off the
// end included. A save comes back as a changed file a moment later, possibly
// after the next save has answered, so the history can't go by the order of
// events. It goes by content instead: a layer may only change to what one of
// our saves wrote, and nothing else in the file may change. Any other change
// (an agent's edit, a hand edit of the file) ends the history, since the
// inverse of an edit is no longer known to be right. Pure, so it is unit tested
// without a browser. A cue's words and the markers go through the same stack,
// under the ids protocol.ts gives them (ADR 0016).

import type { Layer, Scene } from '../engine/types';
import { BACKGROUND_ID } from '../engine/types';
import { cueTarget, editFields, MARKERS_TARGET, type LayerChange } from '../studio/protocol';
import type { FrameRange } from './selection';

type LayerJson = LayerChange['before'];

export interface LayerRecord extends LayerChange {
  layerId: string;
  /** A clip's span on either side, so a range marked on the clip can stay on it. */
  spans?: { before: FrameRange; after: FrameRange };
}

/** Leaves out an anchored key's or marker's t: the file holds the last one known, the library the word's (ADR 0016). */
function withoutAnchoredTime(this: unknown, key: string, value: unknown): unknown {
  return key === 't' && typeof (this as { word?: unknown }).word === 'string' ? undefined : value;
}

/** A layer's JSON for comparing. Its id is its name here, and a clip's `sound` isn't on the layer it renders as. Field order doesn't count. */
export function layerKey(layer: object): string {
  const { id: _id, sound: _sound, ...rest } = layer as Record<string, unknown>;
  return JSON.stringify(Object.keys(rest).sort().map((field) => [field, rest[field]]), withoutAnchoredTime);
}

/** What a scene holds, for telling our saves from anyone else's edit. */
export interface SceneState {
  /** Everything outside its layers, and outside the words and markers a hand edit can change. */
  rest: string;
  /** Layers by id, with cues' words and the markers under their edit targets. */
  layers: ReadonlyMap<string, string>;
}

export function sceneState(scene: Scene): SceneState {
  const layers = new Map(scene.layers.map((layer) => [layer.id, layerKey(layer)]));
  if (scene.background) layers.set(BACKGROUND_ID, layerKey(scene.background));
  const { layers: _layers, background: _background, markers, ...rest } = scene;
  // A video clip's own sound is a cue that follows it.
  const audio = scene.audio
    ?.filter((cue) => !layers.has(cue.id.replace(/:sound$/, '')))
    .map(({ words, ...cue }) => {
      if (words) layers.set(cueTarget(cue.id), layerKey({ words }));
      return cue;
    });
  const ids = [...layers.keys()];
  if (markers) layers.set(MARKERS_TARGET, layerKey({ markers }));
  return { rest: JSON.stringify({ ...rest, audio, ids: ids.filter((id) => id.indexOf('/') < 0) }), layers };
}

/** What turns one target's JSON into another's: its changed fields, and null for a field that goes. */
export function layerSet(from: object, to: object, target = ''): Record<string, unknown> {
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  for (const field of editFields(target)) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) set[field] = b[field] ?? null;
  }
  return set;
}

/** A layer from the file's JSON, to show before the file comes back. */
export function asLayer(id: string, json: LayerJson): Layer {
  return { ...(json as Omit<Layer, 'id'>), id };
}

export class EditHistory {
  private done: LayerRecord[] = [];
  private undone: LayerRecord[] = [];
  private key: string | null = null;
  private state: SceneState | null = null;
  /** The last sync, waiting for the saves under way. */
  private latest: { key: string | null; state: SceneState | null } | null = null;
  /** What our saves have written, "layer|json". */
  private saved = new Set<string>();
  private saving = 0;

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

  /** A save is on its way. What the file does before it answers is judged when it has: only its answer says what it wrote. */
  begin(): void {
    this.saving++;
  }

  /** A save answered. */
  end(): void {
    this.saving--;
    if (this.saving === 0 && this.latest) this.judge();
  }

  /** A save of `key` wrote this. It can be undone, and what was undone before it can't come back. */
  record(key: string, edit: LayerRecord): void {
    if (key !== (this.latest?.key ?? this.key)) return;
    if (layerKey(edit.before) === layerKey(edit.after)) return;
    this.saved.add(`${edit.layerId}|${layerKey(edit.before)}`);
    this.saved.add(`${edit.layerId}|${layerKey(edit.after)}`);
    this.done.push(edit);
    this.undone = [];
  }

  /** Takes the newest edit to apply its `before`, or null. */
  undo(): LayerRecord | null {
    const edit = this.done.pop() ?? null;
    if (edit) this.undone.push(edit);
    return edit;
  }

  /** Takes the newest undone edit to apply its `after`, or null. */
  redo(): LayerRecord | null {
    const edit = this.undone.pop() ?? null;
    if (edit) this.done.push(edit);
    return edit;
  }

  /** What the file holds now. Another scene, or a change our saves don't explain, ends the history. */
  sync(key: string | null, state: SceneState | null): void {
    this.latest = { key, state };
    if (this.saving === 0 || key !== this.key) this.judge();
  }

  private judge(): void {
    const { key, state } = this.latest!;
    this.latest = null;
    const before = this.state;
    if (key !== this.key || !state || !before || state.rest !== before.rest) this.clear();
    else {
      for (const [id, json] of state.layers) {
        if (json !== before.layers.get(id) && !this.saved.has(`${id}|${json}`)) this.clear();
      }
    }
    this.key = key;
    this.state = state;
  }
}
