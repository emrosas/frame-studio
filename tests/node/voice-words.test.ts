import { describe, expect, it } from 'vitest';
import { alignScript, carryWordIds, plainLetters, readWhisperJson, type HeardWord } from '../../tools/voice/words';

const whisper = (tokens: object[]) => new TextEncoder().encode(JSON.stringify({ result: { language: 'es' }, transcription: [{ tokens }] }));
const token = (text: string, from: number, t_dtw: number, p = 1) => ({ text, offsets: { from, to: from + 100 }, t_dtw, p });
/** The bytes a token holds, as whisper-cli writes them, read back as text one byte to a character. */
const raw = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

describe('plainLetters', () => {
  it('drops case, accents and punctuation', () => {
    expect(plainLetters('¿Qué?')).toBe('que');
    expect(plainLetters('niño,')).toBe('nino');
  });

  it('leaves nothing of a lone mark', () => {
    expect(plainLetters('—')).toBe('');
  });
});

describe('readWhisperJson', () => {
  // whisper-cli writes bytes as they are, so the file must be built from raw bytes here, not encoded text.
  const bytes = (tokens: object[]) => Buffer.from(JSON.stringify({ result: { language: 'es' }, transcription: [{ tokens }] }), 'latin1');

  it('joins tokens into words, and ends each at its t_dtw', () => {
    const { language, words } = readWhisperJson(whisper([token('[_BEG_]', 0, -1), token(' con', 0, 40), token('g', 40, 50), token('ela', 50, 80), token(' por', 80, 100)]));
    expect(language).toBe('es');
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([['congela', 0, 0.8], ['por', 0.8, 1]]);
  });

  it('puts back a character cut across two tokens', () => {
    const accented = Buffer.from('í', 'utf8');
    const { words } = readWhisperJson(bytes([{ text: raw(' fr') + String.fromCharCode(accented[0]), offsets: { from: 0, to: 100 }, t_dtw: 10, p: 1 }, { text: `${String.fromCharCode(accented[1])}a`, offsets: { from: 100, to: 200 }, t_dtw: 40, p: 1 }]));
    expect(words[0].text).toBe('fría');
  });

  it('hangs punctuation on its word, and takes a little of the pause', () => {
    const { words } = readWhisperJson(whisper([token(' solid', 0, 100), token('?', 100, 170)]));
    expect(words[0]).toMatchObject({ text: 'solid?', end: 1.12 });
  });

  it('trusts a gap only after punctuation', () => {
    const { words } = readWhisperJson(whisper([token(' one', 0, 50), token(' two', 90, 120), token('.', 120, 125), token(' three', 3000, 340)]));
    expect(words.map((w) => w.start)).toEqual([0, 0.5, 3]);
  });

  it('keeps the lowest confidence of a word', () => {
    const { words } = readWhisperJson(whisper([token(' a', 0, 10, 0.9), token('b', 10, 20, 0.3)]));
    expect(words[0].p).toBe(0.3);
  });

  it('never gives a word no length', () => {
    const { words } = readWhisperJson(whisper([token(' a', 0, 10), token(' b', 10, 10)]));
    expect(words[1].end).toBeGreaterThan(words[1].start);
  });
});

describe('alignScript', () => {
  const heard: HeardWord[] = [
    { text: 'Porque', start: 0, end: 0.6, p: 0.9 },
    { text: 'un', start: 0.6, end: 0.8, p: 0.95 },
    { text: 'lago', start: 0.8, end: 1.2, p: 1 },
  ];

  it('gets ¿Por qué from a heard Porque, with the script\'s spelling and timing from the sound', () => {
    const words = alignScript('¿Por qué un lago?', heard);
    expect(words.map((w) => w.text)).toEqual(['¿Por', 'qué', 'un', 'lago?']);
    expect(words[0].start).toBe(0);
    expect(words[1].end).toBeCloseTo(0.6);
    expect(words[0].end).toBeCloseTo(0.3);
    expect(words[1].p).toBe(0.9);
    expect(words[3]).toMatchObject({ start: 0.8, end: 1.2 });
  });

  it('shares time out to a word it never heard, and marks it unsure', () => {
    const words = alignScript('Un gran lago', [{ text: 'un', start: 0, end: 0.2, p: 1 }, { text: 'lago', start: 1, end: 1.4, p: 1 }]);
    expect(words.map((w) => w.text)).toEqual(['Un', 'gran', 'lago']);
    expect(words[1].p).toBe(0);
    expect(words[1].start).toBeGreaterThanOrEqual(words[0].end);
    expect(words[1].end).toBeLessThanOrEqual(words[2].start);
  });

  it('keeps punctuation that stands alone with the word before it', () => {
    expect(alignScript('un — lago', heard.slice(1)).map((w) => w.text)).toEqual(['un —', 'lago']);
  });

  it('returns ordered, non-empty words, whatever it was given', () => {
    const words = alignScript('uno dos tres cuatro', [{ text: 'cuatro', start: 1, end: 1.1, p: 1 }]);
    words.forEach((w, i) => {
      expect(w.end).toBeGreaterThan(w.start);
      if (i > 0) expect(w.start).toBeGreaterThanOrEqual(words[i - 1].end);
    });
  });

  it('takes a long script in a band', () => {
    const count = 4000;
    const script = Array.from({ length: count }, (_, i) => `palabra${i}`).join(' ');
    const long = Array.from({ length: count }, (_, i) => ({ text: `palabra${i}`, start: i, end: i + 1, p: 1 }));
    const words = alignScript(script, long);
    expect(words).toHaveLength(count);
    expect(words[count - 1].start).toBeCloseTo(count - 1, 0);
  });
});

describe('carryWordIds', () => {
  const take = (...texts: string[]) => texts.map((text, i) => ({ text, start: i, end: i + 1 }));
  const old = take('the', 'crystals', 'lock', 'together').map((w, i) => ({ id: `w${i}`, ...w }));

  it('gives a first take ids from w0', () => {
    expect(carryWordIds([], take('a', 'b')).map((w) => w.id)).toEqual(['w0', 'w1']);
  });

  it('keeps ids across changed timing and punctuation', () => {
    const next = carryWordIds(old, take('The', 'crystals', 'lock', 'together.'));
    expect(next.map((w) => w.id)).toEqual(['w0', 'w1', 'w2', 'w3']);
  });

  it('follows a word that moved, and gives new words new ids', () => {
    const next = carryWordIds(old, take('then', 'the', 'crystals', 'lock', 'tight'));
    expect(next.map((w) => w.id)).toEqual(['w4', 'w0', 'w1', 'w2', 'w5']);
  });
});
