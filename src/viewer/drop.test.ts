import { describe, expect, it } from 'vitest';
import { DRAG_TYPE, dropFrames, dropKind, dropStart, dropTrack, readItem, type LibraryItem } from './drop';
import type { ShotHead } from './ui.svelte';

const scene: LibraryItem = { kind: 'scene', key: 'intro', label: 'Intro', seconds: 2 };
const sound: LibraryItem = { kind: 'media', file: 'voice.wav', label: 'voice.wav', seconds: 1.5 };
const image: LibraryItem = { kind: 'media', file: 'photo.png', label: 'photo.png', seconds: null };
const video: LibraryItem = { kind: 'media', file: 'take.mp4', label: 'take.mp4', seconds: 4 };

describe('dropKind', () => {
  it('makes clips of scenes and pictures on a composition, and cues of sound anywhere', () => {
    expect(dropKind(scene, 'composition', 'video')).toEqual({ as: 'clip' });
    expect(dropKind(image, 'composition', 'video')).toEqual({ as: 'clip' });
    expect(dropKind(video, 'composition', 'video')).toEqual({ as: 'clip' });
    expect(dropKind(sound, 'composition', 'video')).toEqual({ as: 'cue' });
    expect(dropKind(sound, 'scene', 'intro')).toEqual({ as: 'cue' });
  });

  it('refuses scenes and pictures in a scene, and a video in itself, with a reason', () => {
    for (const item of [scene, image, video]) {
      const kind = dropKind(item, 'scene', 'other');
      expect(kind.as).toBe('refused');
      expect(kind.as === 'refused' && kind.reason).toMatch(/video/);
    }
    expect(dropKind({ ...scene, key: 'video' }, 'composition', 'video')).toEqual({ as: 'refused', reason: "A video can't hold itself." });
  });
});

describe('dropFrames', () => {
  it('covers the item at the timeline fps, an image three seconds', () => {
    expect(dropFrames(scene, 24)).toBe(48);
    expect(dropFrames(sound, 30)).toBe(45);
    expect(dropFrames(image, 12)).toBe(36);
    expect(dropFrames(video, 12)).toBe(48);
    expect(dropFrames({ ...sound, seconds: 0.001 }, 12)).toBe(1);
  });
});

describe('dropStart', () => {
  // 10 px a frame: SNAP_PX 6 reaches 0.6 of a frame.
  it('starts at the boundary under the pointer when nothing is near', () => {
    expect(dropStart(20, 10, [0, 100], 10, 100, 'clip')).toBe(20);
  });

  it('snaps the start edge, or the end edge, to a target', () => {
    // Without snapping the start would be 20; a target at 20 is no move.
    expect(dropStart(20, 10, [20], 10, 100, 'clip')).toBe(20);
    // At 1 px a frame, 6 frames reach: the start snaps from 23 to 25, or the end from 33 to 30, whichever is nearer.
    expect(dropStart(23, 10, [25], 1, 100, 'clip')).toBe(25);
    expect(dropStart(23, 10, [31], 1, 100, 'clip')).toBe(21);
  });

  it('never starts before 0, and a cue starts inside the scene', () => {
    expect(dropStart(-5, 10, [], 10, 100, 'clip')).toBe(0);
    expect(dropStart(100, 10, [], 10, 100, 'clip')).toBe(100);
    expect(dropStart(100, 10, [], 10, 100, 'cue')).toBe(99);
  });
});

describe('dropTrack', () => {
  // Top of the stack first: V2 takes lane 0, V1 lanes 1 and 2.
  const heads: ShotHead[] = [
    { name: 'V2', lane: 0, lanes: 1, track: 'V2' },
    { name: 'V1', lane: 1, lanes: 2, track: 'V1' },
  ];

  it('names the track under the pointer', () => {
    expect(dropTrack(5, 90, 3, heads)).toEqual({ into: 'track', track: 'V2' });
    expect(dropTrack(35, 90, 3, heads)).toEqual({ into: 'track', track: 'V1' });
    expect(dropTrack(89, 90, 3, heads)).toEqual({ into: 'track', track: 'V1' });
  });

  it('makes a new track above the rows on top, and below them at the bottom', () => {
    expect(dropTrack(-1, 90, 3, heads)).toEqual({ into: 'top' });
    expect(dropTrack(90, 90, 3, heads)).toEqual({ into: 'bottom' });
    expect(dropTrack(10, 0, 0, [])).toEqual({ into: 'top' });
  });
});

describe('readItem', () => {
  it('reads back what a drag carries, and nothing else', () => {
    expect(DRAG_TYPE).toMatch(/^application\//);
    expect(readItem(JSON.stringify(scene))).toEqual(scene);
    expect(readItem(JSON.stringify({ ...sound, seconds: 'long' }))).toEqual({ ...sound, seconds: null });
    expect(readItem('https://example.com/a.png')).toBeNull();
    expect(readItem(JSON.stringify({ kind: 'scene', label: 'x' }))).toBeNull();
  });
});
