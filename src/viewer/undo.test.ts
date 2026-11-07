import { describe, expect, it } from 'vitest';
import type { Scene } from '../engine/types';
import { asLayer, EditHistory, layerKey, layerSet, sceneState, type LayerRecord } from './undo';

const scene = (layer: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  ({ id: 'cut', fps: 12, duration: 4, size: [640, 360], seed: 0, layers: [{ id: 'one', scene: 'dot', ...layer }], ...rest }) as unknown as Scene;
const json = (start: number) => ({ scene: 'dot', start });
const edit = (a: number, b: number): LayerRecord => ({ layerId: 'one', before: json(a), after: json(b) });

/** A history on scene `cut`, with the clip at `start`. */
function history(start = 1): EditHistory {
  const h = new EditHistory();
  h.sync('cut', sceneState(scene({ start })));
  return h;
}

describe('EditHistory', () => {
  it('undoes newest first and redoes what it undid', () => {
    const h = history();
    h.record('cut', edit(1, 2));
    h.record('cut', edit(2, 3));
    expect(h.undo()).toEqual(edit(2, 3));
    expect(h.undo()).toEqual(edit(1, 2));
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(edit(1, 2));
    expect(h.redo()).toEqual(edit(2, 3));
    expect(h.redo()).toBeNull();
  });

  it('a new edit drops what was undone', () => {
    const h = history();
    h.record('cut', edit(1, 2));
    h.undo();
    h.record('cut', edit(1, 3));
    expect(h.canRedo).toBe(false);
    expect(h.canUndo).toBe(true);
  });

  it('leaves out an edit that changed nothing, and a save of a scene that has left', () => {
    const h = history();
    h.record('cut', edit(1, 1));
    h.record('other', edit(1, 2));
    expect(h.canUndo).toBe(false);
  });

  it('keeps the history through its own saves, even when their file changes arrive late or together', () => {
    const h = history();
    h.begin();
    h.begin();
    // The second save's file arrived before either save answered.
    h.sync('cut', sceneState(scene({ start: 3 })));
    expect(h.canUndo).toBe(false);
    h.record('cut', edit(1, 2));
    h.end();
    h.record('cut', edit(2, 3));
    h.end();
    expect(h.canUndo).toBe(true);
    // The first save's change comes late.
    h.sync('cut', sceneState(scene({ start: 2 })));
    h.sync('cut', sceneState(scene({ start: 3 })));
    expect(h.undo()).toEqual(edit(2, 3));
    h.sync('cut', sceneState(scene({ start: 2 })));
    expect(h.undo()).toEqual(edit(1, 2));
  });

  it('holds its judgement of a change until the save under way has answered', () => {
    const h = history();
    h.record('cut', edit(1, 2));
    h.begin();
    h.sync('cut', sceneState(scene({ start: 9 })));
    expect(h.canUndo).toBe(true);
    h.end();
    expect(h.canUndo).toBe(false);
  });

  it('restores what an edit took, whole: an override a clip move dropped comes back', () => {
    const before = { scene: 'dot', start: 3, overrides: [{ from: 40, to: 48, params: { x: 5 } }] };
    const after = { scene: 'dot', start: 4 };
    const h = new EditHistory();
    h.sync('cut', sceneState(scene(before)));
    h.record('cut', { layerId: 'one', before, after });
    h.sync('cut', sceneState(scene(after)));
    const taken = h.undo()!;
    expect(layerSet(taken.after, taken.before)).toEqual({ start: 3, overrides: before.overrides });
    h.sync('cut', sceneState(scene(before)));
    expect(h.canRedo).toBe(true);
  });

  it('takes field order as no change: a field put back lands last', () => {
    const h = new EditHistory();
    h.sync('cut', sceneState(scene({ start: 1, params: { x: 1 } })));
    h.record('cut', { layerId: 'one', before: { scene: 'dot', start: 1, params: { x: 1 } }, after: { scene: 'dot', start: 1 } });
    h.sync('cut', sceneState(scene({ start: 1 })));
    h.undo();
    h.sync('cut', { ...sceneState(scene({ params: { x: 1 }, start: 1 })) });
    expect(h.canRedo).toBe(true);
  });

  it("counts a video clip's own sound as following it", () => {
    const sound = (start: number) => ({ audio: [{ id: 'one:sound', file: 'media/a.mp4', start, end: start + 1 }] });
    const h = new EditHistory();
    h.sync('cut', sceneState(scene({ start: 1 }, sound(1))));
    h.record('cut', edit(1, 2));
    h.sync('cut', sceneState(scene({ start: 2 }, sound(2))));
    expect(h.canUndo).toBe(true);
  });

  it('follows the background like any layer', () => {
    const paper = (tone: string) => ({ background: { rig: 'paper', params: { tone } } });
    const h = new EditHistory();
    h.sync('cut', sceneState(scene({}, paper('#fff'))));
    h.record('cut', { layerId: 'background', before: paper('#fff').background, after: paper('#000').background });
    h.sync('cut', sceneState(scene({}, paper('#000'))));
    expect(h.canUndo).toBe(true);
    h.sync('cut', sceneState(scene({}, paper('#123'))));
    expect(h.canUndo).toBe(false);
  });

  it('ends the history when something else changes the file', () => {
    const edited = (change: Scene) => {
      const h = history();
      h.record('cut', edit(1, 2));
      h.sync('cut', sceneState(change));
      return h.canUndo;
    };
    expect(edited(scene({ start: 1 }))).toBe(true);
    expect(edited(scene({ start: 5 }))).toBe(false); // a clip moved somewhere no save put it
    expect(edited(scene({ start: 1, params: { scale: 2 } }))).toBe(false);
    expect(edited(scene({ start: 1 }, { markers: [{ t: 1, label: 'new' }] }))).toBe(false);
    expect(edited(scene({ start: 1, tracks: [{ param: 'opacity', keys: [{ t: 1, v: 0 }] }] }))).toBe(false);
  });

  it('ends the history on another scene', () => {
    const h = history();
    h.record('cut', edit(1, 2));
    h.sync('other', sceneState(scene({})));
    expect(h.canUndo).toBe(false);
    h.record('other', edit(1, 2));
    h.sync('other', null);
    expect(h.canUndo).toBe(false);
  });
});

describe('words and markers on the stack (ADR 0016)', () => {
  const words = (end: number) => [{ id: 'w0', text: 'hola', start: 0, end }];
  const cue = (end: number) => ({ id: 'voice', file: 'media/a.mp3', start: 0, end: 4, words: words(end) });
  const start = () => sceneState(scene({ start: 1 }, { audio: [cue(1)], markers: [{ t: 1, label: 'a' }] }));

  it('takes a save of a cue\'s words as ours, and keeps the history', () => {
    const h = new EditHistory();
    h.sync('cut', start());
    h.begin();
    h.record('cut', { layerId: 'audio/voice', before: { words: words(1) }, after: { words: words(2) } });
    h.end();
    h.sync('cut', sceneState(scene({ start: 1 }, { audio: [cue(2)], markers: [{ t: 1, label: 'a' }] })));
    expect(h.canUndo).toBe(true);
  });

  it('a change to a cue beyond its words still ends the history', () => {
    const h = new EditHistory();
    h.sync('cut', start());
    h.record('cut', edit(1, 2));
    h.sync('cut', sceneState(scene({ start: 1 }, { audio: [{ ...cue(1), start: 1 }], markers: [{ t: 1, label: 'a' }] })));
    expect(h.canUndo).toBe(false);
  });

  it('an anchored key that moved with its word is not somebody else\'s edit', () => {
    const anchored = (t: number) => scene({ start: 1, tracks: [{ param: 'x', keys: [{ t, v: 1, word: 'voice#w0' }] }] });
    expect(sceneState(anchored(1)).layers.get('one')).toBe(sceneState(anchored(2)).layers.get('one'));
  });

  it('sets a target\'s own fields', () => {
    expect(layerSet({ words: words(1) }, { words: words(2) }, 'audio/voice')).toEqual({ words: words(2) });
    expect(layerSet({ markers: [] }, { markers: [{ t: 1, label: 'a' }] }, 'markers/')).toEqual({ markers: [{ t: 1, label: 'a' }] });
  });
});

describe('layerKey', () => {
  it("ignores the id, a clip's sound and field order", () => {
    expect(layerKey({ id: 'a', rig: 'x', params: {} })).toBe(layerKey({ params: {}, rig: 'x' }));
    expect(layerKey({ file: 'a.mp4', sound: true })).toBe(layerKey({ file: 'a.mp4' }));
    expect(layerKey({ rig: 'x' })).not.toBe(layerKey({ rig: 'y' }));
  });
});

describe('layerSet', () => {
  it('gives the changed fields, and null for a field that goes', () => {
    expect(layerSet({ rig: 'a', params: { x: 1 }, tracks: [] }, { rig: 'a', params: { x: 2 } })).toEqual({ params: { x: 2 }, tracks: null });
    expect(layerSet({ params: { x: 1 } }, { params: { x: 1 } })).toEqual({});
  });
});

describe('asLayer', () => {
  it('puts the id back on the file JSON', () => {
    expect(asLayer('one', { rig: 'a' })).toEqual({ id: 'one', rig: 'a' });
  });
});
