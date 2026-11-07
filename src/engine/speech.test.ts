import { describe, expect, it } from 'vitest';
import { PASS_THROUGH } from './kit';
import { anchorWords, cueWords, parseWordRef, sceneWords, speechKit, unanchoredWords, wordRef, wordTime } from './speech';
import type { AudioCue, Scene } from './types';
import { validateScene } from './validate';

const WORDS = [
  { id: 'w0', text: 'Why', start: 0.5, end: 0.8 },
  { id: 'w1', text: 'lakes', start: 0.8, end: 1.2 },
  { id: 'w2', text: 'freeze.', start: 1.2, end: 2 },
];
const cue = (over: Partial<AudioCue> = {}): AudioCue => ({ id: 'voice', file: 'media/v.mp3', start: 1, end: 4, words: WORDS, ...over });
const scene = (over: Partial<Scene> = {}): Scene => ({ id: 's', fps: 12, duration: 6, size: [640, 360], seed: 1, layers: [], audio: [cue()], ...over });

describe('cueWords', () => {
  it('moves words to scene time with the cue', () => {
    expect(cueWords(cue(), 12).map((w) => [w.start, w.end])).toEqual([[1.5, 1.8], [1.8, 2.2], [2.2, 3]]);
  });

  it('trims with in, and a word the trim cuts through stops at the cut', () => {
    const words = cueWords(cue({ in: 0.9 }), 12);
    expect(words.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(words[0].start).toBe(1);
    expect(words[0].end).toBeCloseTo(1.3);
  });

  it('drops what the end cuts off', () => {
    const words = cueWords(cue({ end: 2 }), 12);
    expect(words.map((w) => w.id)).toEqual(['w0', 'w1']);
    expect(words[1].end).toBe(2);
  });

  it('starts on the frame the sound starts on', () => {
    expect(cueWords(cue({ start: 1.04 }), 12)[0].start).toBe(1.5);
  });
});

describe('references', () => {
  it('round trips', () => {
    expect(parseWordRef(wordRef('voice', 'w12'))).toEqual({ cue: 'voice', word: 'w12' });
  });

  it('takes the last # as the divider, so a cue id can hold one', () => {
    expect(parseWordRef('take#2#w1')).toEqual({ cue: 'take#2', word: 'w1' });
  });

  it.each(['voice', '#w1', 'voice#'])('refuses %s', (ref) => {
    expect(parseWordRef(ref)).toBeNull();
  });

  it('finds a word in scene time, and not one the trim took', () => {
    expect(wordTime(scene(), 'voice#w1')).toBe(1.8);
    expect(wordTime(scene(), 'voice#nope')).toBeNull();
    expect(wordTime(scene({ audio: [cue({ in: 0.9 })] }), 'voice#w0')).toBeNull();
  });
});

describe('kit.speech', () => {
  it('reads the cue from the scene the rig is in', () => {
    const kit = speechKit(PASS_THROUGH, scene());
    expect(kit.speech('voice').map((w) => w.text)).toEqual(['Why', 'lakes', 'freeze.']);
    expect(kit.speech('other')).toEqual([]);
  });

  it('reads the words of a cue an embed left out', () => {
    const quiet = scene({ audio: undefined, spoken: [cue()] });
    expect(speechKit(PASS_THROUGH, quiet).speech('voice')).toHaveLength(3);
  });

  it('gives a rig the same words each frame, so its layout can stay', () => {
    const s = scene();
    expect(sceneWords(s, 'voice')).toBe(sceneWords(s, 'voice'));
  });
});

describe('anchorWords', () => {
  const anchored = () =>
    scene({
      markers: [{ t: 0.1, label: 'lock!', word: 'voice#w2' }, { t: 5, label: 'plain' }],
      camera: { tracks: [{ param: 'zoom', keys: [{ t: 0, v: 1, word: 'voice#w0' }] }] },
      background: { rig: 'paper', tracks: [{ param: 'tone', keys: [{ t: 0, v: '#fff', word: 'voice#w1' }] }] },
      layers: [{ id: 'a', rig: 'circle', tracks: [{ param: 'x', keys: [{ t: 0, v: 0, word: 'voice#w2' }, { t: 2.5, v: 1 }] }], mask: { rig: 'circle', tracks: [{ param: 'x', keys: [{ t: 0, v: 0, word: 'voice#w0' }] }] } }],
    });

  it('overwrites t on keys and markers everywhere', () => {
    const out = anchorWords(anchored());
    expect(out.markers?.map((m) => m.t)).toEqual([2.2, 5]);
    expect(out.camera?.tracks?.[0].keys[0].t).toBe(1.5);
    expect(out.background?.tracks?.[0].keys[0].t).toBe(1.8);
    expect(out.layers[0].tracks?.[0].keys[0].t).toBe(2.2);
    expect(out.layers[0].mask?.tracks?.[0].keys[0].t).toBe(1.5);
  });

  it('leaves its input alone, and returns a scene with no anchors as it is', () => {
    const input = anchored();
    const copy = structuredClone(input);
    anchorWords(input);
    expect(input).toEqual(copy);
    const plain = scene();
    expect(anchorWords(plain)).toBe(plain);
  });

  it('keeps keys in time order when a word moves past another key', () => {
    const s = scene({ layers: [{ id: 'a', rig: 'circle', tracks: [{ param: 'x', keys: [{ t: 0, v: 0, word: 'voice#w2' }, { t: 1, v: 1 }] }] }] });
    expect(anchorWords(s).layers[0].tracks?.[0].keys.map((k) => k.t)).toEqual([1, 2.2]);
  });

  it('follows a retimed word', () => {
    const s = anchored();
    s.audio = [cue({ words: [WORDS[0], WORDS[1], { ...WORDS[2], start: 1.5 }] })];
    expect(anchorWords(s).layers[0].tracks?.[0].keys[0].t).toBe(2.5);
  });

  it('an orphan keeps its last t, and is reported', () => {
    const s = scene({ markers: [{ t: 3.25, label: 'gone', word: 'voice#w9' }] });
    expect(anchorWords(s).markers?.[0].t).toBe(3.25);
    expect(unanchoredWords(s)).toEqual([{ where: 'marker "gone"', word: 'voice#w9', t: 3.25 }]);
  });

  it('a word trimmed off counts as gone', () => {
    const s = scene({ audio: [cue({ in: 1.3 })], layers: [{ id: 'a', rig: 'circle', tracks: [{ param: 'x', keys: [{ t: 3, v: 0, word: 'voice#w0' }] }] }] });
    expect(unanchoredWords(s).map((o) => o.where)).toEqual(['layer "a", x']);
  });
});

describe('validation', () => {
  const errors = (over: Partial<AudioCue>, rest: Partial<Scene> = {}) => {
    const out = validateScene(scene({ audio: [cue(over)], ...rest }));
    return out.ok ? [] : out.errors;
  };

  it('takes words, a script and a language', () => {
    expect(errors({ script: 'Why lakes freeze.', lang: 'en' })).toEqual([]);
  });

  it('refuses duplicate ids', () => {
    expect(errors({ words: [WORDS[0], { ...WORDS[1], id: 'w0' }] }).join()).toContain('duplicate word id');
  });

  it('refuses words out of order', () => {
    expect(errors({ words: [WORDS[1], WORDS[0]] }).join()).toContain("don't overlap");
  });

  it('refuses a word that ends before it starts', () => {
    expect(errors({ words: [{ ...WORDS[0], end: 0.2 }] }).join()).toContain('start < end');
  });

  it('refuses a # in a word id, which would break a reference', () => {
    expect(errors({ words: [{ ...WORDS[0], id: 'a#b' }] }).join()).toContain('without "#"');
  });

  it('refuses words on a generator', () => {
    const out = validateScene(scene({ audio: [{ id: 'g', generator: 'blip', start: 0, end: 1, words: WORDS }] }));
    expect(out.ok ? [] : out.errors.join()).toContain('only a sound file cue');
  });

  it('takes a word on a key or marker, and refuses the wrong shape', () => {
    expect(errors({}, { markers: [{ t: 1, label: 'a', word: 'voice#w0' }] })).toEqual([]);
    expect(errors({}, { markers: [{ t: 1, label: 'a', word: 'voice' }] }).join()).toContain('cueId#wordId');
  });

  it('lets an orphan through: a re-record can do that, and the check tool reports it', () => {
    expect(errors({}, { markers: [{ t: 1, label: 'a', word: 'voice#w99' }] })).toEqual([]);
  });
});
