// A cue's words on the timeline (ADR 0016): the chips a voice row shows, and
// what dragging an edge or typing over a word does to the cue. Word times are
// seconds into the file, so these turn scene frames into file time and back. It
// edits a word's text and timing; nothing else. Pure, so it's unit tested
// without a browser.

import { cueWords } from '../engine/speech';
import { timeToFrame } from '../engine/time';
import type { AudioCue, SpokenWord } from '../engine/types';

/** What a voice row needs of its cue. */
export type VoiceCue = Pick<AudioCue, 'id' | 'start' | 'end' | 'in'> & { words: readonly SpokenWord[] };

/** A word on the row. `from` and `to` are frames with a fraction, so a chip sits where the word does, inside a frame too. */
export interface WordChip {
  id: string;
  /** Its place in the cue's words. */
  index: number;
  text: string;
  from: number;
  to: number;
  /** The frame the word starts on: where a click lands. */
  frame: number;
}

/** A cue with words, as a row of the timeline. */
export interface VoiceLine {
  cue: VoiceCue;
  label: string;
  from: number;
  to: number;
  file: { path: string; from: number; to: number };
}

const tidy = (t: number) => Math.round(t * 1e6) / 1e6;

/** The chips for what the cue plays, in order. */
export function wordChips(cue: VoiceCue, fps: number): WordChip[] {
  const index = new Map(cue.words.map((word, i) => [word.id, i]));
  return cueWords({ ...cue, words: [...cue.words] }, fps).map((word) => ({
    id: word.id,
    index: index.get(word.id) ?? 0,
    text: word.text,
    from: word.start * fps,
    to: word.end * fps,
    frame: timeToFrame(word.start, fps),
  }));
}

/** Seconds into the file at a frame of the scene. */
export function fileTime(cue: Pick<AudioCue, 'start' | 'in'>, frame: number, fps: number): number {
  return tidy((frame - timeToFrame(cue.start, fps)) / fps + (cue.in ?? 0));
}

/**
 * The words with one edge of one word on `frame`. It stops a frame short of the word's other edge. A word
 * that touches its neighbour shares that edge, since timing leaves no gap between most words, so the neighbour
 * gives way until it's a frame long. A gap stops the drag at the neighbour.
 */
export function retimeWord(cue: VoiceCue, index: number, edge: 'start' | 'end', frame: number, fps: number): SpokenWord[] {
  const words = cue.words.map((word) => ({ ...word }));
  const word = words[index];
  if (!word) return words;
  const least = 1 / fps;
  const at = fileTime(cue, frame, fps);
  const clamp = (t: number, min: number, max: number) => tidy(Math.max(min, Math.min(max, t)));
  if (edge === 'start') {
    const before = words[index - 1];
    const touching = before !== undefined && Math.abs(before.end - word.start) < 1e-6;
    word.start = clamp(at, touching ? before.start + least : (before?.end ?? 0), word.end - least);
    if (touching) before.end = word.start;
  } else {
    const after = words[index + 1];
    const touching = after !== undefined && Math.abs(after.start - word.end) < 1e-6;
    word.end = clamp(at, word.start + least, touching ? after.end - least : (after?.start ?? Infinity));
    if (touching) after.start = word.end;
  }
  return words;
}

/** The words with one word reading `text`. Blank keeps what it said. */
export function renameWord(words: readonly SpokenWord[], index: number, text: string): SpokenWord[] {
  const clean = text.trim().replace(/\s+/g, ' ');
  return words.map((word, i) => (i === index && clean !== '' ? { ...word, text: clean } : word));
}
