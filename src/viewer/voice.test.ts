import { describe, expect, it } from 'vitest';
import { fileTime, renameWord, retimeWord, wordChips, type VoiceCue } from './voice';

const FPS = 12;
const cue = (over: Partial<VoiceCue> = {}): VoiceCue => ({
  id: 'voice',
  start: 1,
  end: 6,
  in: 0.5,
  words: [
    { id: 'w0', text: 'one', start: 1, end: 2 },
    { id: 'w1', text: 'two', start: 2, end: 3 },
    { id: 'w2', text: 'three', start: 3.5, end: 4 },
  ],
  ...over,
});

describe('chips', () => {
  it('sit where the cue plays the word, in frames', () => {
    const [first] = wordChips(cue(), FPS);
    expect(first.from).toBeCloseTo(18);
    expect(first.to).toBeCloseTo(30);
    expect(first.frame).toBe(18);
  });

  it('keep their place in the cue when the trim drops some', () => {
    const chips = wordChips(cue({ in: 2.5 }), FPS);
    expect(chips.map((c) => [c.id, c.index])).toEqual([['w1', 1], ['w2', 2]]);
  });
});

describe('fileTime', () => {
  it('undoes the cue shift and adds the trim', () => {
    expect(fileTime(cue(), 24, FPS)).toBe(1.5);
  });
});

describe('retimeWord', () => {
  it('lands a loose edge on the frame', () => {
    const words = retimeWord(cue(), 2, 'end', 57, FPS);
    expect(words[2].end).toBeCloseTo(4.25);
  });

  it('a shared edge moves both words', () => {
    const words = retimeWord(cue(), 0, 'end', 33, FPS);
    expect(words[0].end).toBeCloseTo(2.25);
    expect(words[1].start).toBeCloseTo(2.25);
  });

  it('never crosses a neighbour across a gap', () => {
    expect(retimeWord(cue(), 2, 'start', 12, FPS)[2].start).toBe(3);
    expect(retimeWord(cue(), 1, 'end', 100, FPS)[1].end).toBe(3.5);
  });

  it('a shared edge stops a frame short of the far side of the neighbour', () => {
    const words = retimeWord(cue(), 0, 'end', 90, FPS);
    expect(words[1].start).toBeCloseTo(3 - 1 / FPS);
    expect(words[1].end).toBe(3);
  });

  it('keeps a word at least a frame long', () => {
    const words = retimeWord(cue(), 2, 'start', 200, FPS);
    expect(words[2].start).toBeCloseTo(4 - 1 / FPS);
  });

  it('leaves the cue it was given alone', () => {
    const c = cue();
    retimeWord(c, 0, 'end', 33, FPS);
    expect(c.words[0].end).toBe(2);
  });
});

describe('renameWord', () => {
  it('changes the text and nothing else', () => {
    expect(renameWord(cue().words, 1, ' dos ')[1]).toEqual({ id: 'w1', text: 'dos', start: 2, end: 3 });
  });

  it('keeps the word when the field is left blank', () => {
    expect(renameWord(cue().words, 1, '  ')[1].text).toBe('two');
  });
});
