// From what Whisper heard to the words a cue keeps (ADR 0016): whisper-cli's
// JSON read into words, a known script laid over them, and a new take's words
// matched to an old take's, so anchors survive a re-record. Pure, so it's unit
// tested without whisper. Times here are seconds into the file.

import type { SpokenWord } from '../../src/engine/types.ts';

/** A word Whisper heard, before it has an id. */
export type HeardWord = Omit<SpokenWord, 'id'>;

/** A silence longer than this before a word means the word doesn't start where the last one ended. */
const GAP = 0.2;
/** How much of the pause a word's last sound rings into, at most, when punctuation follows it. */
const TAIL = 0.12;
/** No word is shorter than this, so a chip stays a chip and start stays before end. */
const MIN_WORD = 0.02;
/** How far the alignment strays from the diagonal, at most, in characters. It decides the memory used. */
const MAX_BAND = 600;
const MAX_CELLS = 256e6;

const tidy = (t: number) => Math.round(t * 1000) / 1000;

interface WhisperToken {
  text: string;
  offsets?: { from: number; to: number };
  p?: number;
  t_dtw?: number;
}

interface WhisperFull {
  result?: { language?: string };
  transcription?: { tokens?: WhisperToken[] }[];
}

/** Letters and digits, lower case, without accents: what two spellings of a word have in common. */
export function plainLetters(text: string): string {
  return text.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/**
 * The words in whisper-cli's --output-json-full. t_dtw marks where a token ends, in hundredths of a second, so a
 * word ends at its last spoken token and starts where the word before ended. Two things around punctuation:
 * a mark's t_dtw lands in the pause after the word, so a word's last sound gets a little of that pause; and the only real
 * gaps come after punctuation, where a token's own offsets say when speech came back. Elsewhere those offsets
 * wander too much to trust. The file is read as bytes because a token can end halfway through a
 * UTF-8 character and the next one finish it: Spanish does that.
 */
export function readWhisperJson(bytes: Uint8Array): { language: string | null; words: HeardWord[] } {
  const json = JSON.parse(Buffer.from(bytes).toString('latin1')) as WhisperFull;
  const words: HeardWord[] = [];
  let open: { text: number[]; from: number; end: number; tail: number; p: number } | null = null;
  let previousEnd = 0;
  let afterPause = true;
  const close = () => {
    if (!open) return;
    const text = Buffer.from(open.text).toString('utf8').trim();
    if (plainLetters(text)) {
      const start = afterPause && open.from - previousEnd > GAP && open.from < open.end ? open.from : previousEnd;
      const end = Math.max(open.end + Math.min(TAIL, Math.max(0, open.tail - open.end)), start + MIN_WORD);
      words.push({ text, start: tidy(start), end: tidy(end), p: Math.round(open.p * 100) / 100 });
      previousEnd = end;
      afterPause = /\P{L}$/u.test(text) && !/\p{N}$/u.test(text);
    } else if (words.length > 0) {
      // Loose punctuation belongs to the word before it.
      words[words.length - 1].text += text;
      afterPause = true;
    }
    open = null;
  };
  for (const segment of json.transcription ?? []) {
    for (const token of segment.tokens ?? []) {
      if (token.text.startsWith('[_') || token.text.startsWith('[BLANK')) continue;
      const bytesOf = [...Buffer.from(token.text, 'latin1')];
      const from = (token.offsets?.from ?? 0) / 1000;
      const end = token.t_dtw !== undefined && token.t_dtw >= 0 ? token.t_dtw / 100 : (token.offsets?.to ?? 0) / 1000;
      const spoken = plainLetters(Buffer.from(bytesOf).toString('utf8')) !== '';
      // 0x20 is the space a new word's first token starts with.
      if (bytesOf[0] === 0x20) close();
      if (!open) open = { text: [], from, end: 0, tail: 0, p: 1 };
      open.text.push(...bytesOf);
      if (spoken) {
        if (open.end === 0) open.from = from;
        open.end = end;
        open.tail = end;
        open.p = Math.min(open.p, token.p ?? 1);
      } else {
        open.tail = end;
      }
    }
  }
  close();
  return { language: json.result?.language ?? null, words };
}

/** For each character of `a`, the character of `b` it lines up with, or -1: edit distance, in a band around the diagonal. */
function alignLetters(a: string, b: string): Int32Array {
  const n = a.length;
  const m = b.length;
  const map = new Int32Array(n).fill(-1);
  if (n === 0 || m === 0) return map;
  const band = Math.max(Math.abs(n - m) + 16, Math.min(MAX_BAND, Math.floor(MAX_CELLS / (n + 1) / 2) - 1));
  const width = 2 * band + 1;
  const centre = (i: number) => Math.round((i * m) / n);
  // 0 from the diagonal, 1 skips a letter of a, 2 skips a letter of b.
  const moves = new Uint8Array((n + 1) * width);
  let previous = new Int32Array(width).fill(1e9);
  let current = new Int32Array(width);
  for (let k = 0; k < width; k++) {
    const j = k - band;
    if (j >= 0) {
      previous[k] = j;
      moves[k] = 2;
    }
  }
  for (let i = 1; i <= n; i++) {
    const shift = centre(i) - centre(i - 1);
    current.fill(1e9);
    for (let k = 0; k < width; k++) {
      const j = centre(i) + k - band;
      if (j < 0 || j > m) continue;
      let best = 1e9;
      let move = 0;
      const up = k + shift;
      if (j > 0 && up - 1 >= 0 && up - 1 < width) {
        best = previous[up - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
        move = 0;
      }
      if (up >= 0 && up < width && previous[up] + 1 < best) {
        best = previous[up] + 1;
        move = 1;
      }
      if (k > 0 && current[k - 1] + 1 < best) {
        best = current[k - 1] + 1;
        move = 2;
      }
      current[k] = best;
      moves[i * width + k] = move;
    }
    [previous, current] = [current, previous];
  }
  let i = n;
  let j = m;
  while (i > 0) {
    const k = j - centre(i) + band;
    if (k < 0 || k >= width) break;
    const move = moves[i * width + k];
    if (move === 0) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (move === 1) i--;
    else j--;
    if (j < 0) break;
  }
  return map;
}

/**
 * The script's words with Whisper's timing. Words and punctuation come from the script, always. Letters of the
 * two line up one by one, so "Porque" heard for "¿Por qué" splits in two, and "qué" takes the second half of
 * the heard word. A script word with too little lined up shares the time around it by its length, with p 0.
 */
export function alignScript(script: string, heard: readonly HeardWord[]): HeardWord[] {
  if (plainLetters(script) === '') throw new Error('That script has no words in it, only punctuation.');
  const texts = script.split(/\s+/).filter((t) => plainLetters(t) !== '' || /\S/.test(t));
  // Punctuation standing alone, like a dash, hangs on the word before it.
  const merged: string[] = [];
  for (const text of texts) {
    if (plainLetters(text) === '' && merged.length > 0) merged[merged.length - 1] += ` ${text}`;
    else merged.push(text);
  }
  const letters = merged.map(plainLetters);
  const heardLetters = heard.map((w) => plainLetters(w.text));
  const said = letters.join('');
  const sounded = heardLetters.join('');
  const map = alignLetters(said, sounded);

  // Where each heard letter falls in time.
  const owner: { word: number; at: number; of: number }[] = [];
  heardLetters.forEach((w, word) => {
    for (let at = 0; at < w.length; at++) owner.push({ word, at, of: w.length });
  });
  const letterStart = (j: number) => {
    const { word, at, of } = owner[j];
    return heard[word].start + ((heard[word].end - heard[word].start) * at) / of;
  };
  const letterEnd = (j: number) => {
    const { word, at, of } = owner[j];
    return heard[word].start + ((heard[word].end - heard[word].start) * (at + 1)) / of;
  };

  const out: { text: string; start: number; end: number; p?: number; length: number; timed: boolean }[] = [];
  let cursor = 0;
  letters.forEach((w, index) => {
    const lined: number[] = [];
    let same = 0;
    for (let i = cursor; i < cursor + w.length; i++) {
      if (map[i] < 0) continue;
      lined.push(map[i]);
      if (said[i] === sounded[map[i]]) same++;
    }
    cursor += w.length;
    // Mostly other letters means it wasn't this word that was heard there.
    if (same * 2 < w.length) {
      out.push({ text: merged[index], start: 0, end: 0, length: Math.max(1, w.length), timed: false });
      return;
    }
    const first = lined[0];
    const last = lined[lined.length - 1];
    const spanned = heard.slice(owner[first].word, owner[last].word + 1);
    out.push({ text: merged[index], start: letterStart(first), end: letterEnd(last), p: Math.min(...spanned.map((h) => h.p ?? 1)), length: w.length, timed: true });
  });

  // Share out the words that lined up with nothing.
  for (let i = 0; i < out.length; i++) {
    if (out[i].timed) continue;
    let stop = i;
    while (stop < out.length && !out[stop].timed) stop++;
    const from = i > 0 ? out[i - 1].end : (heard[0]?.start ?? 0);
    const to = stop < out.length ? out[stop].start : Math.max(from, heard[heard.length - 1]?.end ?? from);
    const lengths = out.slice(i, stop).reduce((sum, w) => sum + w.length, 0);
    let at = from;
    for (let k = i; k < stop; k++) {
      const end = at + ((to - from) * out[k].length) / lengths;
      out[k] = { ...out[k], start: at, end, p: 0 };
      at = end;
    }
    i = stop - 1;
  }

  // In order, and never empty.
  let previous = 0;
  return out.map(({ text, start, end, p }) => {
    const a = Math.max(previous, start);
    const b = Math.max(end, a + MIN_WORD);
    previous = b;
    return { text, start: tidy(a), end: tidy(b), ...(p !== undefined ? { p } : {}) };
  });
}

/**
 * Ids for a take's words. A word that matches one of the last take's, by text in order, keeps its id, so a key
 * anchored to it follows it to its new time. The rest get ids nothing has used. The match is a longest
 * common subsequence over plain letters.
 */
export function carryWordIds(old: readonly SpokenWord[], next: readonly HeardWord[]): SpokenWord[] {
  const a = old.map((w) => plainLetters(w.text));
  const b = next.map((w) => plainLetters(w.text));
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const kept = new Map<number, string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) kept.set(j++, old[i++].id);
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  let fresh = old.reduce((most, w) => Math.max(most, /^w(\d+)$/.test(w.id) ? Number(w.id.slice(1)) + 1 : 0), 0);
  return next.map((word, index) => ({ id: kept.get(index) ?? `w${fresh++}`, ...word }));
}
