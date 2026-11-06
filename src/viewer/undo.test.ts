import { describe, expect, it } from 'vitest';
import type { Scene } from '../engine/types';
import { ClipHistory, clipPlaceKey, clipState, type ClipEdit } from './undo';

const place = (from: number) => ({ from, in: 0, out: 24, length: 24 });
const edit = (a: number, b: number): ClipEdit => ({ layerId: 'one', before: place(a), after: place(b) });
const scene = (layer: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  ({ id: 'cut', fps: 12, duration: 4, size: [640, 360], seed: 0, layers: [{ id: 'one', scene: 'dot', ...layer }], ...rest }) as unknown as Scene;
const at = (start: number) => clipPlaceKey(start, 0, undefined);

describe('ClipHistory', () => {
  it('undoes newest first and redoes what it undid', () => {
    const h = new ClipHistory();
    h.record(edit(0, 6));
    h.record(edit(6, 12));
    expect(h.undo()).toEqual(edit(6, 12));
    expect(h.undo()).toEqual(edit(0, 6));
    expect(h.undo()).toBeNull();
    expect(h.redo()).toEqual(edit(0, 6));
    expect(h.redo()).toEqual(edit(6, 12));
    expect(h.redo()).toBeNull();
  });

  it('a new edit drops what was undone', () => {
    const h = new ClipHistory();
    h.record(edit(0, 6));
    h.undo();
    h.record(edit(0, 3));
    expect(h.canRedo).toBe(false);
    expect(h.canUndo).toBe(true);
  });

  it('keeps the history through its own saves, even when their file changes arrive late or together', () => {
    const h = new ClipHistory();
    h.sync('cut', clipState(scene({ start: 1 })));
    h.saving('one', at(1.5));
    h.record(edit(12, 18));
    h.saving('one', at(2));
    h.record(edit(18, 24));
    // The second save answered before the first one's change arrived.
    h.sync('cut', clipState(scene({ start: 1.5 })));
    h.sync('cut', clipState(scene({ start: 2 })));
    expect(h.undo()).toEqual(edit(18, 24));
    expect(h.undo()).toEqual(edit(12, 18));
  });

  it("counts a clip's keys and overrides as moving with it", () => {
    const h = new ClipHistory();
    const move = { tracks: [{ param: 'opacity', keys: [{ t: 1, v: 0 }] }], overrides: [{ from: 12, to: 24, params: {} }] };
    h.sync('cut', clipState(scene({ start: 1, ...move })));
    h.saving('one', at(1.5));
    h.record(edit(12, 18));
    h.sync(
      'cut',
      clipState(scene({ start: 1.5, tracks: [{ param: 'opacity', keys: [{ t: 1.5, v: 0 }] }], overrides: [{ from: 18, to: 30, params: {} }] })),
    );
    expect(h.canUndo).toBe(true);
  });

  it("counts a video clip's own sound as moving with it", () => {
    const h = new ClipHistory();
    const sound = (start: number) => ({ audio: [{ id: 'one:sound', file: 'media/a.mp4', start, end: start + 1 }] });
    h.sync('cut', clipState(scene({ start: 1 }, sound(1))));
    h.saving('one', at(2));
    h.record(edit(12, 24));
    h.sync('cut', clipState(scene({ start: 2 }, sound(2))));
    expect(h.canUndo).toBe(true);
  });

  it('ends the history when something else changes the file', () => {
    const edited = (change: Scene) => {
      const h = new ClipHistory();
      h.sync('cut', clipState(scene({ start: 1 })));
      h.record(edit(12, 18));
      h.sync('cut', clipState(change));
      return h.canUndo;
    };
    expect(edited(scene({ start: 1 }))).toBe(true);
    expect(edited(scene({ start: 3 }))).toBe(false); // a clip moved somewhere no save put it
    expect(edited(scene({ start: 1, params: { scale: 2 } }))).toBe(false);
    expect(edited(scene({ start: 1 }, { markers: [{ t: 1, label: 'new' }] }))).toBe(false);
    expect(edited(scene({ start: 1, tracks: [{ param: 'opacity', keys: [{ t: 1, v: 0 }] }] }))).toBe(false);
  });

  it('ends the history on another composition', () => {
    const h = new ClipHistory();
    h.sync('cut', clipState(scene({})));
    h.record(edit(0, 6));
    h.sync('other', clipState(scene({})));
    expect(h.canUndo).toBe(false);
    h.record(edit(0, 6));
    h.sync('other', null);
    expect(h.canUndo).toBe(false);
  });
});
