import { describe, expect, it } from 'vitest';
import { evaluateTrack } from '../engine/tracks';
import type { Track } from '../engine/types';
import { applyTimelineEdit, checkTimelineEdit, freshId, transitionSeconds, type RawClip, type TimelineFile } from './timeline-edit';

const video = (): TimelineFile => ({
  fps: 12,
  duration: 10,
  tracks: [
    { id: 'V1', clips: [{ id: 'a', scene: 'one', start: 1, in: 0.5, out: 4.5 }, { id: 'b', file: 'media/p.png', start: 5, out: 2 }] },
    { id: 'V2', clips: [] },
  ],
  audio: [{ id: 'voice', file: 'media/v.wav', start: 2, end: 6, in: 1, fadeIn: 0.5, fadeOut: 0.25, words: [{ id: 'w0', start: 1.5, end: 2 }, { id: 'w1', start: 3.5, end: 4 }], script: 'one two', tracks: [{ param: 'volume', keys: [{ t: 2, v: 1 }, { t: 3, v: 0.5 }] }] }],
});
const clip = (file: TimelineFile, id: string) => file.tracks!.flatMap((t) => t.clips).find((c) => c.id === id)!;
const cue = (file: TimelineFile, id: string) => file.audio!.find((c) => c.id === id)!;

describe('clips', () => {
  it('splits a clip into two that meet at the cut', () => {
    const file = video();
    expect(applyTimelineEdit(file, { op: 'split-clip', clip: 'a', at: 3 })).toEqual({ made: 'a-2' });
    expect(clip(file, 'a')).toMatchObject({ start: 1, in: 0.5, out: 2.5 });
    expect(clip(file, 'a-2')).toMatchObject({ start: 3, in: 2.5, out: 4.5 });
    expect(file.tracks![0].clips.map((c) => c.id)).toEqual(['a', 'a-2', 'b']);
  });

  it('cuts on the frame at any rate, where a coarse rounding of seconds would land a frame early', () => {
    for (const fps of [12, 24, 25, 30, 48, 60]) {
      for (let frame = 1; frame < fps * 3; frame++) {
        const file: TimelineFile = { fps, duration: 4, tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'one', in: 1 / fps, out: 3.5 }] }] };
        applyTimelineEdit(file, { op: 'split-clip', clip: 'a', at: frame / fps });
        expect(Math.floor(clip(file, 'a').out! * fps + 1e-9)).toBe(frame + 1);
        expect(Math.floor(clip(file, 'a-2').in! * fps + 1e-9)).toBe(frame + 1);
      }
    }
  });

  it('meets at the cut for a clip that starts between frames', () => {
    const file: TimelineFile = { fps: 24, duration: 4, tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'one', start: 1.01, out: 3 }] }] };
    applyTimelineEdit(file, { op: 'split-clip', clip: 'a', at: 2 });
    expect(clip(file, 'a').out).toBeCloseTo(1, 9);
    expect(clip(file, 'a-2').in).toBeCloseTo(1, 9);
  });

  it('carries keys past zero, so a curve into the clip survives a move to the start', () => {
    const file: TimelineFile = { fps: 12, duration: 6, tracks: [{ id: 'V1', clips: [{ id: 'a', scene: 'one', start: 3, tracks: [{ param: 'opacity', keys: [{ t: 1, v: 0 }, { t: 5, v: 1 }] }] }] }] };
    applyTimelineEdit(file, { op: 'move-clip', clip: 'a', track: 'V1', start: 0, in: 0, out: null });
    expect(clip(file, 'a').tracks![0].keys.map((k) => k.t)).toEqual([-2, 2]);
  });

  it('keeps every key curve as it was on each side of a cut', () => {
    const track: Track = { param: 'opacity', keys: [{ t: 1, v: 0 }, { t: 2, v: 1, ease: 'inOutCubic' }, { t: 3, v: 0.5, ease: 'inOutCubic' }, { t: 5, v: 1, ease: 'outCubic' }] };
    const file = video();
    file.tracks![0].clips[0].tracks = [structuredClone(track)] as RawClip['tracks'];
    applyTimelineEdit(file, { op: 'split-clip', clip: 'a', at: 2.5 });
    const left = clip(file, 'a').tracks![0] as Track;
    const right = clip(file, 'a-2').tracks![0] as Track;
    expect(left.keys.map((k) => k.t)).toEqual([1, 2, 3]);
    expect(right.keys.map((k) => k.t)).toEqual([2, 3, 5]);
    for (let t = 1; t < 2.5; t += 0.1) expect(evaluateTrack(left, t)).toBeCloseTo(evaluateTrack(track, t) as number, 9);
    for (let t = 2.5; t < 5; t += 0.1) expect(evaluateTrack(right, t)).toBeCloseTo(evaluateTrack(track, t) as number, 9);
  });

  it('gives each half the part of an override inside it', () => {
    const file = video();
    file.tracks![0].clips[0].overrides = [{ from: 24, to: 48 }, { from: 12, to: 18 }];
    applyTimelineEdit(file, { op: 'split-clip', clip: 'a', at: 3 });
    expect(clip(file, 'a').overrides).toEqual([{ from: 24, to: 36 }, { from: 12, to: 18 }]);
    expect(clip(file, 'a-2').overrides).toEqual([{ from: 36, to: 48 }]);
  });

  it('refuses a split outside the clip', () => {
    expect(() => applyTimelineEdit(video(), { op: 'split-clip', clip: 'a', at: 1 })).toThrow(/inside "a"/);
    expect(() => applyTimelineEdit(video(), { op: 'split-clip', clip: 'a', at: 5 })).toThrow(/inside "a"/);
  });

  it('splits a clip without an out at its real end', () => {
    const file: TimelineFile = { fps: 12, duration: 5, tracks: [{ id: 'V1', clips: [{ id: 's', scene: 'one' }] }] };
    expect(() => applyTimelineEdit(file, { op: 'split-clip', clip: 's', at: 2 }, () => 2)).toThrow(/inside/);
    applyTimelineEdit(file, { op: 'split-clip', clip: 's', at: 1 }, () => 2);
    expect(clip(file, 's')).toMatchObject({ out: 1 });
    expect(clip(file, 's-2')).toMatchObject({ start: 1, in: 1 });
    expect(clip(file, 's-2').out).toBeUndefined();
  });

  it('duplicates a clip after itself with its keys, growing a video that runs out', () => {
    const file = video();
    file.tracks![0].clips[1].tracks = [{ param: 'x', keys: [{ t: 5, v: 1 }] }];
    expect(applyTimelineEdit(file, { op: 'duplicate-clip', clip: 'b' })).toEqual({ made: 'b-2' });
    expect(clip(file, 'b-2')).toMatchObject({ start: 7, out: 2, tracks: [{ param: 'x', keys: [{ t: 7, v: 1 }] }] });
    expect(file.duration).toBe(10);
    applyTimelineEdit(file, { op: 'duplicate-clip', clip: 'a' });
    expect(file.duration).toBe(10);
    file.duration = 8;
    applyTimelineEdit(file, { op: 'duplicate-clip', clip: 'b-2' });
    expect(file.duration).toBe(11);
  });

  it('deletes a clip and leaves its track', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'delete-clip', clip: 'b' });
    expect(file.tracks![0].clips.map((c) => c.id)).toEqual(['a']);
    expect(() => applyTimelineEdit(file, { op: 'delete-clip', clip: 'b' })).toThrow(/no clip/);
  });

  it('adds a clip on the wanted track, else the lowest with room, else a new one', () => {
    const file = video();
    expect(applyTimelineEdit(file, { op: 'add-clip', source: { scene: 'two' }, at: 0, length: 1, track: null })).toEqual({ made: 'two' });
    expect(file.tracks![0].clips.map((c) => c.id)).toContain('two');
    applyTimelineEdit(file, { op: 'add-clip', source: { scene: 'two' }, at: 2, length: 1, track: 'V1' });
    expect(file.tracks![1].clips.map((c) => c.id)).toEqual(['two-2']);
    applyTimelineEdit(file, { op: 'add-clip', source: { file: 'media/My Clip.png' }, at: 2, length: 3, track: null });
    expect(file.tracks![2]).toMatchObject({ id: 'V3', clips: [{ id: 'my-clip', file: 'media/My Clip.png', start: 2, out: 3 }] });
  });

  it('grows a video to hold a new clip', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'add-clip', source: { scene: 'two' }, at: 9, length: 4, track: null });
    expect(file.duration).toBe(13);
  });

  it('moves a clip to another track, on top of it', () => {
    const file = video();
    file.tracks![1].clips.push({ id: 'c', scene: 'one' });
    file.tracks![0].clips[0].tracks = [{ param: 'x', keys: [{ t: 1, v: 0 }] }];
    applyTimelineEdit(file, { op: 'move-clip', clip: 'a', track: 'V2', start: 2, in: 0.5, out: null });
    expect(file.tracks![0].clips.map((c) => c.id)).toEqual(['b']);
    expect(file.tracks![1].clips.map((c) => c.id)).toEqual(['c', 'a']);
    expect(clip(file, 'a')).toMatchObject({ start: 2, tracks: [{ keys: [{ t: 2 }] }] });
    expect(clip(file, 'a').out).toBeUndefined();
  });

  it('keeps a picture clip\'s out when it moves', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'move-clip', clip: 'b', track: 'V2', start: 0, in: 0, out: null });
    expect(clip(file, 'b').out).toBe(2);
    expect(clip(file, 'b').start).toBeUndefined();
  });

  it('adds tracks and only deletes empty ones', () => {
    const file = video();
    expect(applyTimelineEdit(file, { op: 'add-track' })).toEqual({ made: 'V3' });
    applyTimelineEdit(file, { op: 'delete-track', track: 'V3' });
    expect(file.tracks!.map((t) => t.id)).toEqual(['V1', 'V2']);
    expect(() => applyTimelineEdit(file, { op: 'delete-track', track: 'V1' })).toThrow(/still has clips/);
    applyTimelineEdit(file, { op: 'delete-clip', clip: 'a' });
    applyTimelineEdit(file, { op: 'delete-clip', clip: 'b' });
    applyTimelineEdit(file, { op: 'delete-track', track: 'V1' });
    expect(() => applyTimelineEdit(file, { op: 'delete-track', track: 'V2' })).toThrow(/at least one/);
  });

  it('refuses tracks on a scene', () => {
    expect(() => applyTimelineEdit({ fps: 12, duration: 1 }, { op: 'add-track' })).toThrow(/videos/);
  });
});

describe('sound', () => {
  it('moves a cue with its volume keys, and a trim leaves them', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'edit-cue', cue: 'voice', start: 3, end: 7 });
    expect(cue(file, 'voice')).toMatchObject({ start: 3, end: 7, in: 1 });
    expect(cue(file, 'voice').tracks![0].keys.map((k) => k.t)).toEqual([3, 4]);
    applyTimelineEdit(file, { op: 'edit-cue', cue: 'voice', start: 4, end: 7, in: 2 });
    expect(cue(file, 'voice').tracks![0].keys.map((k) => k.t)).toEqual([3, 4]);
  });

  it('sets fades and clears one at zero, up to the cue\'s length', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'edit-cue', cue: 'voice', start: 2, end: 6, fadeIn: 0, fadeOut: 9 });
    expect(cue(file, 'voice').fadeIn).toBeUndefined();
    expect(cue(file, 'voice').fadeOut).toBe(4);
  });

  it('gives a generator no trim into a file', () => {
    const file: TimelineFile = { fps: 12, duration: 5, audio: [{ id: 'g', generator: 'buzz', start: 1, end: 2 }] };
    applyTimelineEdit(file, { op: 'edit-cue', cue: 'g', start: 0.5, end: 2, in: 3 });
    expect(file.audio![0]).toEqual({ id: 'g', generator: 'buzz', start: 0.5, end: 2 });
  });

  it('splits a cue so the two play on from each other, with words on the half that says them', () => {
    const file = video();
    expect(applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 4 })).toEqual({ made: 'voice-2' });
    const left = cue(file, 'voice');
    const right = cue(file, 'voice-2');
    expect(left).toMatchObject({ start: 2, end: 4, in: 1, fadeIn: 0.5 });
    expect(left.fadeOut).toBeUndefined();
    expect(right).toMatchObject({ start: 4, end: 6, in: 3, fadeOut: 0.25 });
    expect(right.fadeIn).toBeUndefined();
    expect(left.words!.map((w) => w.id)).toEqual(['w0']);
    expect(right.words!.map((w) => w.id)).toEqual(['w1']);
    expect(left.script).toBeUndefined();
  });

  it('refuses to split a voice that captions or anchors read', () => {
    const read = (extra: object) => {
      const file = { ...video(), ...extra };
      return () => applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 4 });
    };
    expect(read({ layers: [{ id: 'c', rig: 'captions', params: { cue: 'voice' } }] })).toThrow(/Captions or word anchors/);
    expect(read({ markers: [{ t: 1, label: 'x', word: 'voice#w1' }] })).toThrow(/Captions or word anchors/);
    expect(read({ markers: [{ t: 1, label: 'x', word: 'voices#w1' }] })).not.toThrow();
  });

  it('refuses to split inside a fade, which the halves can\'t carry', () => {
    const file = video();
    expect(() => applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 2.25 })).toThrow(/inside a fade/);
    expect(() => applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 5.9 })).toThrow(/inside a fade/);
    expect(() => applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 2.5 })).not.toThrow();
  });

  it('refuses to split a voice another cue\'s keys are anchored to', () => {
    const file = video();
    file.audio!.push({ id: 'music', file: 'media/m.wav', start: 0, end: 1, tracks: [{ param: 'volume', keys: [{ t: 0, v: 1, word: 'voice#w1' }] }] });
    expect(() => applyTimelineEdit(file, { op: 'split-cue', cue: 'voice', at: 4 })).toThrow(/Captions or word anchors/);
  });

  it('refuses to split a generator, which would start over', () => {
    expect(() => applyTimelineEdit({ fps: 12, duration: 5, audio: [{ id: 'g', generator: 'buzz', start: 1, end: 2 }] }, { op: 'split-cue', cue: 'g', at: 1.5 })).toThrow(/starts over/);
  });

  it('duplicates a cue after itself, stopping at a scene\'s end and growing a video', () => {
    const scene: TimelineFile = { fps: 12, duration: 5, audio: [{ id: 'g', generator: 'buzz', start: 1, end: 4 }] };
    applyTimelineEdit(scene, { op: 'duplicate-cue', cue: 'g' });
    expect(scene.audio![1]).toEqual({ id: 'g-2', generator: 'buzz', start: 4, end: 5 });
    expect(scene.duration).toBe(5);
    expect(() => applyTimelineEdit(scene, { op: 'duplicate-cue', cue: 'g-2' })).toThrow(/no room/);
    const file = video();
    file.duration = 7;
    applyTimelineEdit(file, { op: 'duplicate-cue', cue: 'voice' });
    expect(file.duration).toBe(10);
  });

  it('deletes a cue, and the list with its last', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'delete-cue', cue: 'voice' });
    expect(file.audio).toBeUndefined();
  });
});

describe('transitions', () => {
  it('writes a crossfade as plain opacity keys and keeps a later fade', () => {
    const file = video();
    file.tracks![0].clips[0].tracks = [{ param: 'opacity', keys: [{ t: 3, v: 1 }, { t: 4, v: 0 }] }];
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: 'crossfade', seconds: 0.5 });
    expect(clip(file, 'a').tracks![0].keys).toEqual([{ t: 1, v: 0 }, { t: 1.5, v: 1, ease: 'inOutCubic' }, { t: 3, v: 1 }, { t: 4, v: 0 }]);
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: null, seconds: 0 });
    expect(clip(file, 'a').tracks![0].keys).toEqual([{ t: 3, v: 1 }, { t: 4, v: 0 }]);
  });

  it('writes wipe and iris as masks, and one preset replaces another', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: 'wipe', seconds: 1 });
    expect(clip(file, 'a').mask).toEqual({ rig: 'mask-wipe', tracks: [{ param: 'progress', keys: [{ t: 1, v: 0 }, { t: 2, v: 1, ease: 'inOutCubic' }] }] });
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: 'iris', seconds: 1 });
    expect(clip(file, 'a').mask).toMatchObject({ rig: 'mask-iris' });
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: 'crossfade', seconds: 1 });
    expect(clip(file, 'a').mask).toBeUndefined();
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: null, seconds: 0 });
    expect(clip(file, 'a').tracks).toBeUndefined();
  });

  it('leaves an agent\'s mask alone', () => {
    const file = video();
    file.tracks![0].clips[0].mask = { rig: 'circle' };
    expect(() => applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: 'wipe', seconds: 1 })).toThrow(/already has a mask/);
    applyTimelineEdit(file, { op: 'transition', clip: 'a', preset: null, seconds: 0 });
    expect(clip(file, 'a').mask).toEqual({ rig: 'circle' });
  });

  it('runs the clip before on under the transition, and back when it comes off', () => {
    const file = video();
    applyTimelineEdit(file, { op: 'transition', clip: 'b', preset: 'crossfade', seconds: 0.5, under: { clip: 'a', out: 5 } });
    expect(clip(file, 'a').out).toBe(5);
    expect(transitionSeconds(clip(file, 'b'))).toBe(0.5);
    applyTimelineEdit(file, { op: 'transition', clip: 'b', preset: null, seconds: 0, under: { clip: 'a', out: 4.5 } });
    expect(clip(file, 'a').out).toBe(4.5);
    expect(transitionSeconds(clip(file, 'b'))).toBeNull();
    applyTimelineEdit(file, { op: 'transition', clip: 'b', preset: 'wipe', seconds: 1, under: { clip: 'a', out: null } });
    expect(clip(file, 'a').out).toBeUndefined();
    expect(transitionSeconds(clip(file, 'b'))).toBe(1);
  });
});

describe('checks', () => {
  it('refuses malformed edits', () => {
    expect(checkTimelineEdit(null)).toMatch(/JSON object/);
    expect(checkTimelineEdit({ op: 'nope' })).toMatch(/unknown/);
    expect(checkTimelineEdit({ op: 'split-clip', clip: 'a' })).toMatch(/at must/);
    expect(checkTimelineEdit({ op: 'edit-cue', cue: 'a', start: 2, end: 1 })).toMatch(/before end/);
    expect(checkTimelineEdit({ op: 'transition', clip: 'a', preset: 'spin', seconds: 1 })).toMatch(/preset/);
    expect(checkTimelineEdit({ op: 'transition', clip: 'a', preset: 'wipe', seconds: 0 })).toMatch(/seconds/);
    expect(checkTimelineEdit({ op: 'transition', clip: 'a', preset: null, seconds: 0 })).toBeNull();
    expect(checkTimelineEdit({ op: 'add-clip', source: { scene: 'a' }, at: 0 })).toBeNull();
    expect(checkTimelineEdit({ op: 'move-clip', clip: 'a', track: 'V1', start: 0, in: 2, out: 1 })).toMatch(/after in/);
  });

  it('names a fresh id', () => {
    expect(freshId('a', new Set())).toBe('a');
    expect(freshId('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(freshId('a-2', new Set(['a', 'a-2']))).toBe('a-3');
  });
});
