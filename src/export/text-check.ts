// The checks that read text: is it cut by the frame, under a platform's
// interface, up long enough to read, and distinct from what's behind it.
// Where text is comes from the scene (text-marks.ts); only contrast needs
// pixels, which the render page hands in. Everything here is arithmetic on
// those, unit tested on synthetic data. Never imported by the runtime.

import { safeArea, type SafeArea } from '../engine/safe-area';
import type { CheckRank, CheckResult } from './check';
import { intersect, wordCount, type Appearance, type Box, type TextMark } from './text-marks';

/** Text may run this many output pixels past an edge before it counts: glyph boxes come from control points, which can only err large. */
const EDGE_SLACK = 2;
/** A box that moves less than this many output pixels between frames holds still. */
const REST_PIXELS = 0.5;
/** Text holds still when its box hasn't moved for this long either side, so a layer stepped on fours still counts as moving. */
const REST_SECONDS = 0.25;
/** Reading takes this long a word: 200 words a minute, a little under adult silent reading of non-fiction (about 240, Brysbaert 2019), since the picture competes. */
const SECONDS_PER_WORD = 0.3;
/** And at least this long, for a word or two: a fixation and a moment to find it. */
const MIN_READING_SECONDS = 1;
/** Text this opaque reads; a fade counts from here. */
const READABLE_OPACITY = 0.5;
/** WCAG 1.4.3: 4.5:1, and 3:1 for large text (1.4.11 asks 3:1 of graphics too). */
const CONTRAST_NORMAL = 4.5;
const CONTRAST_LARGE = 3;
/**
 * WCAG's large text is 24 CSS px. A video has no CSS pixels, so large here is an em of at least this share of the
 * frame's short side: 24 px on a 720 px tall player.
 */
const LARGE_SHARE = 1 / 30;
/** A text is measured at this percentile of its pixels: a few stray background pixels don't decide it, a bright patch behind a tenth of it does. */
const CONTRAST_PERCENTILE = 0.1;
/** An outline counts once it's this wide in output pixels, and this share of the em: thinner, it doesn't separate the fill from the ground. */
const OUTLINE_MIN_PIXELS = 2;
const OUTLINE_MIN_SHARE = 1 / 20;
/** Contrast is sampled every this many seconds of readable text, plus its first frame, and at most CONTRAST_SAMPLES times. */
const CONTRAST_EVERY = 0.5;
const CONTRAST_SAMPLES = 24;
/** A finding lists this many texts, then counts the rest. */
const LISTED = 3;

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
const seconds = (value: number): string => `${round(value, 1)} s`;
const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${flat.length > 32 ? `${flat.slice(0, 31)}…` : flat}"`;
};
const named = (a: Pick<Appearance, 'path' | 'text'>) => `${snippet(a.text)} (${a.path})`;

function listed(lines: readonly string[]): string {
  const shown = lines.slice(0, LISTED);
  const rest = lines.length - shown.length;
  return `${shown.join('. ')}${rest > 0 ? `. And ${rest} more` : ''}.`;
}

/** The [from, to) runs of consecutive frames in a sorted list. */
function frameRuns(frames: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && last[1] === f) last[1] = f + 1;
    else out.push([f, f + 1]);
  }
  return out;
}

/** Whether any of the text shows: it overlaps the area it can show in. */
const shows = (mark: TextMark) => {
  const seen = intersect(mark.box, mark.area);
  return seen.width > 0 && seen.height > 0;
};
const sameBox = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < REST_PIXELS && Math.abs(a.y - b.y) < REST_PIXELS && Math.abs(a.width - b.width) < REST_PIXELS && Math.abs(a.height - b.height) < REST_PIXELS;

/** For each frame of an appearance, whether its box holds still: unchanged for REST_SECONDS either side, within the appearance. */
export function restingFrames(appearance: Pick<Appearance, 'frames'>, fps: number): boolean[] {
  const { frames } = appearance;
  const reach = Math.max(1, Math.round(REST_SECONDS * fps));
  return frames.map(({ mark }, i) => {
    for (let j = Math.max(0, i - reach); j <= Math.min(frames.length - 1, i + reach); j++) {
      if (!sameBox(mark.box, frames[j].mark.box)) return false;
    }
    return true;
  });
}

/** Which edges a box runs past. */
function edgesPast(box: Box, area: SafeArea): ('top' | 'bottom' | 'left' | 'right')[] {
  const out: ('top' | 'bottom' | 'left' | 'right')[] = [];
  if (box.y < area.y - EDGE_SLACK) out.push('top');
  if (box.y + box.height > area.y + area.height + EDGE_SLACK) out.push('bottom');
  if (box.x < area.x - EDGE_SLACK) out.push('left');
  if (box.x + box.width > area.x + area.width + EDGE_SLACK) out.push('right');
  return out;
}

const inRange = (frame: number, from: number, to: number) => frame >= from && frame < to;

interface Finding {
  appearance: Appearance;
  frames: number[];
  edges: Set<string>;
}

function collect(appearances: readonly Appearance[], fps: number, from: number, to: number, test: (mark: TextMark) => string[] | null, skip: (a: Appearance) => boolean = () => false): Finding[] {
  const out: Finding[] = [];
  for (const appearance of appearances) {
    if (skip(appearance)) continue;
    const resting = restingFrames(appearance, fps);
    const finding: Finding = { appearance, frames: [], edges: new Set() };
    appearance.frames.forEach(({ frame, mark }, i) => {
      if (!resting[i] || !inRange(frame, from, to)) return;
      const edges = test(mark);
      if (!edges || edges.length === 0) return;
      finding.frames.push(frame);
      for (const e of edges) finding.edges.add(e);
    });
    if (finding.frames.length > 0) out.push(finding);
  }
  return out;
}

const joinEdges = (edges: Iterable<string>) => {
  const list = [...edges];
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/** Text resting across the frame edge. Text moving through it is an entrance or an exit, and passes. */
export function checkTextFrame(appearances: readonly Appearance[], fps: number, from: number, to: number): CheckResult {
  if (appearances.length === 0) return { id: 'text-frame', status: 'pass', message: 'There is no text.', value: 0 };
  // The area is the frame, cut down to the edges of any moved clip the text is inside: those hide letters too.
  const found = collect(appearances, fps, from, to, (mark) => (shows(mark) ? edgesPast(mark.box, mark.area) : null));
  if (found.length === 0) return { id: 'text-frame', status: 'pass', message: 'Text stays inside the frame while it holds still.', value: 0 };
  return {
    id: 'text-frame',
    status: 'warn',
    message: listed(found.map((f) => `${named(f.appearance)} runs past the ${joinEdges(f.edges)} ${f.edges.size === 1 ? 'edge' : 'edges'}`)),
    frames: found.flatMap((f) => frameRuns(f.frames)),
    value: found.length,
  };
}

const ZONES: Record<string, string> = { top: 'the account name and tabs at the top', bottom: 'the caption and name at the bottom', right: 'the buttons on the right', left: 'the left edge' };

/**
 * Text inside the zones a platform's interface covers (src/engine/safe-area.ts): on a vertical stage, what TikTok,
 * Reels and Shorts lay over it (P1); on any other shape, a 5% title-safe margin (P3). Cut text is text-frame's to
 * report, and captions in the scene itself are caption-safe's.
 */
export function checkTextSafe(appearances: readonly Appearance[], size: readonly [number, number], fps: number, from: number, to: number): CheckResult {
  const [width, height] = size;
  const vertical = height > width;
  const rank: CheckRank = vertical ? 'P1' : 'P3';
  const judged = appearances.filter((a) => !(a.rig === 'captions' && a.top));
  if (judged.length === 0) return { id: 'text-safe', status: 'pass', rank, message: 'There is no text to place.', value: 0 };
  const area = safeArea(width, height);
  const found = collect(judged, fps, from, to, (mark) => (shows(mark) && edgesPast(mark.box, mark.area).length === 0 ? edgesPast(mark.box, area) : null));
  const where = vertical ? 'clear of the platform interface' : 'inside the title-safe margin';
  if (found.length === 0) return { id: 'text-safe', status: 'pass', rank, message: `Text stays ${where}.`, value: 0 };
  const line = (f: Finding) =>
    vertical ? `${named(f.appearance)} sits under ${joinEdges([...f.edges].map((e) => ZONES[e]))}` : `${named(f.appearance)} crosses the title-safe margin at the ${joinEdges(f.edges)}`;
  return { id: 'text-safe', status: 'warn', rank, message: listed(found.map(line)), frames: found.flatMap((f) => frameRuns(f.frames)), value: found.length };
}

/** Whether text on a frame can be read: all of it drawn, opaque enough, and on screen. */
export const readable = (mark: TextMark): boolean => mark.complete && mark.opacity >= READABLE_OPACITY && shows(mark);

/** The time text needs on screen. */
export const readingSeconds = (text: string): number => Math.max(MIN_READING_SECONDS, SECONDS_PER_WORD * wordCount(text));

/** Whether each appearance of text stays readable long enough. Captions are caption-speed's to judge. */
export function checkReadingTime(appearances: readonly Appearance[], fps: number, from: number, to: number): CheckResult {
  const judged = appearances.filter((a) => a.rig !== 'captions' && a.frames.some(({ frame }) => inRange(frame, from, to)) && wordCount(a.text) > 0);
  if (judged.length === 0) return { id: 'reading-time', status: 'pass', message: 'There is no text to read.', value: 0 };
  const short: { a: Appearance; shown: number; needed: number }[] = [];
  for (const a of judged) {
    const shown = a.frames.filter(({ mark }) => readable(mark)).length / fps;
    const needed = readingSeconds(a.text);
    if (shown + 1e-9 < needed) short.push({ a, shown, needed });
  }
  if (short.length === 0) return { id: 'reading-time', status: 'pass', message: `${judged.length === 1 ? 'The text stays' : `All ${judged.length} texts stay`} up long enough to read.`, value: 0 };
  return {
    id: 'reading-time',
    status: 'warn',
    message: listed(short.map(({ a, shown, needed }) => `${named(a)} reads for ${seconds(shown)} and needs ${seconds(needed)}`)),
    frames: short.map(({ a }) => [a.frames[0].frame, a.frames[a.frames.length - 1].frame + 1]),
    value: short.length,
  };
}

// ---- contrast ----

/** sRGB level, 0 to 255, to linear light, as WCAG 2.x defines relative luminance. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

const linear = (level: number): number => LINEAR[Math.max(0, Math.min(255, Math.round(level)))];

/** WCAG relative luminance of an sRGB colour in levels of 255. */
export const luminance = (r: number, g: number, b: number): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** The WCAG contrast ratio of two luminances, 1 to 21. */
export const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** A colour in levels of 255, with alpha 0 to 1. */
export type Rgba = readonly [number, number, number, number];

const mix = (top: readonly number[], under: readonly number[], alpha: number): [number, number, number] => [
  top[0] * alpha + under[0] * (1 - alpha),
  top[1] * alpha + under[1] * (1 - alpha),
  top[2] * alpha + under[2] * (1 - alpha),
];
const lum = (c: readonly number[]) => luminance(c[0], c[1], c[2]);

export interface ContrastInput {
  /** What's behind the text: the frame drawn without its layer, RGBA. */
  pixels: ArrayLike<number>;
  width: number;
  height: number;
  /** Output pixels per measured pixel, across and down. */
  scale: readonly [number, number];
  /** Whether an output pixel is behind the text's glyphs. */
  inside: (x: number, y: number) => boolean;
  fills: readonly Rgba[];
  stroke: Rgba | null;
  /** In output pixels. */
  strokeWidth: number;
  /** The em, in output pixels. */
  size: number;
  opacity: number;
}

/** The text's contrast at its CONTRAST_PERCENTILE pixel, for its worst fill colour. Null when no measured pixel is behind it. */
export function measureContrast(input: ContrastInput): number | null {
  const { pixels, width, height, scale, opacity } = input;
  const behind: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (input.inside((x + 0.5) * scale[0], (y + 0.5) * scale[1])) behind.push((y * width + x) * 4);
    }
  }
  if (behind.length === 0) return null;
  // Each pixel's ground is the mean of its 3x3 neighbourhood: grain that fine averages out, as it does to the eye.
  const groundAt = (i: number): number[] => {
    const p = i / 4;
    const cx = p % width;
    const cy = (p - cx) / width;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.max(0, cy - 1); y <= Math.min(height - 1, cy + 1); y++) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(width - 1, cx + 1); x++) {
        const j = (y * width + x) * 4;
        sum[0] += pixels[j];
        sum[1] += pixels[j + 1];
        sum[2] += pixels[j + 2];
        n++;
      }
    }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  };
  const grounds = behind.map(groundAt);
  const outlined = input.stroke !== null && input.strokeWidth >= Math.max(OUTLINE_MIN_PIXELS, input.size * OUTLINE_MIN_SHARE);
  let worst = Infinity;
  for (const fill of input.fills) {
    const ratios = grounds.map((ground) => {
      const text = mix(fill, ground, fill[3] * opacity);
      const plain = contrastRatio(lum(text), lum(ground));
      if (!outlined) return plain;
      // The outline sits between the fill and the ground, so the fill reads against it.
      const edge = mix(input.stroke!, ground, input.stroke![3] * opacity);
      return Math.max(plain, contrastRatio(lum(mix(fill, edge, fill[3] * opacity)), lum(edge)));
    });
    ratios.sort((a, b) => a - b);
    worst = Math.min(worst, ratios[Math.floor(CONTRAST_PERCENTILE * (ratios.length - 1))]);
  }
  return worst;
}

/** Whether a text this size counts as large, for the 3:1 threshold. */
export const isLarge = (size: number, frame: readonly [number, number]): boolean => size >= Math.min(frame[0], frame[1]) * LARGE_SHARE;

/** The frames to measure an appearance's contrast on: its first readable frame in range, then every CONTRAST_EVERY seconds. */
export function contrastFrames(appearance: Pick<Appearance, 'frames'>, fps: number, from: number, to: number): number[] {
  const frames = appearance.frames.filter(({ frame, mark }) => inRange(frame, from, to) && readable(mark)).map(({ frame }) => frame);
  if (frames.length === 0) return [];
  const step = Math.max(1, Math.round(CONTRAST_EVERY * fps), Math.ceil(frames.length / CONTRAST_SAMPLES));
  return frames.filter((_, i) => i % step === 0);
}

export interface ContrastSample {
  path: string;
  text: string;
  frame: number;
  ratio: number;
  large: boolean;
}

/** Each text's contrast at its worst moment, against 4.5:1, or 3:1 when large. */
export function checkTextContrast(samples: readonly ContrastSample[]): CheckResult {
  if (samples.length === 0) return { id: 'text-contrast', status: 'pass', message: 'There is no readable text to measure.' };
  const worst = new Map<string, ContrastSample>();
  for (const s of samples) {
    const key = `${s.path}\u0000${s.text}`;
    const known = worst.get(key);
    if (!known || s.ratio < known.ratio) worst.set(key, s);
  }
  const all = [...worst.values()];
  const low = all.filter((s) => s.ratio < (s.large ? CONTRAST_LARGE : CONTRAST_NORMAL)).sort((a, b) => a.ratio - b.ratio);
  const value = round(Math.min(...all.map((s) => s.ratio)));
  if (low.length === 0) return { id: 'text-contrast', status: 'pass', message: `Text contrast is at least ${value}:1 against what's behind it.`, value };
  return {
    id: 'text-contrast',
    status: 'warn',
    rank: low.some((s) => s.ratio < CONTRAST_LARGE) ? 'P1' : 'P2',
    message: listed(low.map((s) => `${named(s)} is ${round(s.ratio, 1)}:1 against what's behind it at frame ${s.frame}, under ${s.large ? CONTRAST_LARGE : CONTRAST_NORMAL}:1`)),
    frames: low.map((s) => [s.frame, s.frame + 1]),
    value,
  };
}

/** The text checks that need no pixels. */
export function textLayoutChecks(appearances: readonly Appearance[], size: readonly [number, number], fps: number, from: number, to: number): CheckResult[] {
  return [checkTextFrame(appearances, fps, from, to), checkTextSafe(appearances, size, fps, from, to), checkReadingTime(appearances, fps, from, to)];
}
