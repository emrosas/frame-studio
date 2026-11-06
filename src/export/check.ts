// Measured checks: numbers about a video, for an agent that can't watch or
// hear it and a person about to export it. The render page draws the frames
// small and hands the pixels here, with the scene's rendered audio; everything
// in this file is arithmetic on those, so it is unit tested on synthetic
// pixels and samples. Never imported by the runtime.

/** The longest side frames are measured at. Plenty for black, freezes and flashes, and quick to draw. */
export const CHECK_MAX_SIZE = 320;

/** The rate the studio renders all audio at (ADR 0005). The K-weighting coefficients below are for this rate. */
const SAMPLE_RATE = 48000;

/** A pixel this close to the frame's mean colour, in levels of 255, counts as that colour. Paper grain stays inside it. */
const FLAT_LEVELS = 24;
/** A frame this much one colour is blank: a small thing on a plain ground still counts, for sparse stretches. */
const BLANK_SHARE = 0.97;
/** A frame this much one colour shows nothing at all, for the opening. */
const EMPTY_SHARE = 0.999;
/** A pixel with no channel above this is black. */
const BLACK_LEVEL = 24;
/** A frame this much black is a black frame. */
const BLACK_SHARE = 0.98;
/** A pixel that moves by more than this, in levels of 255, has changed. */
const MOTION_LEVELS = 8;
/** An opening where less than this share of the picture ever changes is static. */
const STATIC_SHARE = 0.001;
/** Identical frames for longer than this are a freeze. */
const FREEZE_SECONDS = 1.5;
/** Blank frames for longer than this are a sparse stretch. */
const SPARSE_SECONDS = 3;
/** The opening is the first second. */
const OPENING_SECONDS = 1;
/** A loop seam counts when it is bigger than this, and than SEAM_STEPS ordinary frame steps. */
const SEAM_FLOOR = 0.01;
const SEAM_STEPS = 3;
/** WCAG 2.3.1: a swing is a change of at least this in relative luminance, with the darker side under FLASH_DARK. */
const FLASH_SWING = 0.1;
const FLASH_DARK = 0.8;
/** More than this many flashes in any one second fails. A flash is a swing up and back, so two opposing changes. */
const FLASHES_PER_SECOND = 3;
const LUFS_RANGE: readonly [number, number] = [-18, -12];
const TRUE_PEAK_LIMIT = -1;
/** Audio below this is silence, for dropouts. */
const SILENCE_DB = -60;
/** Silence longer than this between two sounds is a dropout. */
const DROPOUT_SECONDS = 1;
/** A marker with a trailing ! expects a sound to start within this many frames. */
const MARKER_FRAMES = 2;

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  /** Where it happens, as [from, to) frame ranges of the scene. */
  frames?: [number, number][];
  /** The measurement: seconds, LUFS, dBTP or a share, as the message says. */
  value?: number;
}

export interface CheckReport {
  /** False when any check failed. Warnings leave it true. */
  ok: boolean;
  scene: string;
  from: number;
  to: number;
  checks: CheckResult[];
}

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
const seconds = (value: number): string => `${round(value)} s`;

/** The size to measure a frame of this size at: never larger, and at least a pixel each way. */
export function checkSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, CHECK_MAX_SIZE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

// ---- frames ----

/** sRGB level to linear light. */
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** What one frame measures. */
export interface FrameStats {
  /** Mean relative luminance, 0 to 1. */
  luminance: number;
  black: boolean;
  /** Nearly one colour. */
  blank: boolean;
  /** One colour, with nothing on it. */
  empty: boolean;
  /** Byte for byte the frame before it. */
  same: boolean;
  /** Mean difference from the frame before it, 0 to 1. */
  step: number;
  /** Share of pixels that differ from the first frame. */
  moved: number;
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>): { total: number; mean: number; changed: number } {
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const r = Math.abs(a[i] - b[i]);
    const g = Math.abs(a[i + 1] - b[i + 1]);
    const v = Math.abs(a[i + 2] - b[i + 2]);
    total += r + g + v;
    if (r > MOTION_LEVELS || g > MOTION_LEVELS || v > MOTION_LEVELS) changed++;
  }
  const pixels = a.length / 4;
  return { total, mean: total / (pixels * 3 * 255), changed: changed / pixels };
}

/** Measures frames in order, keeping only the numbers and the pixels the next frame and the seam need. */
export class FrameMeter {
  readonly stats: FrameStats[] = [];
  private first: ArrayLike<number> | null = null;
  private last: ArrayLike<number> | null = null;

  /** Takes one frame's RGBA pixels. The meter keeps a reference, so each frame needs its own array. */
  add(rgba: ArrayLike<number>): void {
    const pixels = rgba.length / 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let light = 0;
    let black = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      light += 0.2126 * LINEAR[rgba[i]] + 0.7152 * LINEAR[rgba[i + 1]] + 0.0722 * LINEAR[rgba[i + 2]];
      if (rgba[i] <= BLACK_LEVEL && rgba[i + 1] <= BLACK_LEVEL && rgba[i + 2] <= BLACK_LEVEL) black++;
    }
    r /= pixels;
    g /= pixels;
    b /= pixels;
    let flat = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (Math.abs(rgba[i] - r) <= FLAT_LEVELS && Math.abs(rgba[i + 1] - g) <= FLAT_LEVELS && Math.abs(rgba[i + 2] - b) <= FLAT_LEVELS) flat++;
    }
    const before = this.last ? difference(rgba, this.last) : null;
    const opening = this.first ? difference(rgba, this.first) : null;
    this.stats.push({
      luminance: light / pixels,
      black: black / pixels >= BLACK_SHARE,
      blank: flat / pixels >= BLANK_SHARE,
      empty: flat / pixels >= EMPTY_SHARE,
      same: before !== null && before.total === 0,
      step: before?.mean ?? 0,
      moved: opening?.changed ?? 0,
    });
    this.first ??= rgba;
    this.last = rgba;
  }

  /** How far the last frame is from the first, 0 to 1. */
  get seam(): number {
    return this.first && this.last ? difference(this.last, this.first).mean : 0;
  }
}

/** The [from, to) index runs where `test` holds. */
function runs(count: number, test: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= count; i++) {
    const on = i < count && test(i);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

const longest = (spans: readonly (readonly [number, number])[]): number => Math.max(0, ...spans.map(([a, b]) => b - a));
const shift = (spans: readonly [number, number][], by: number): [number, number][] => spans.map(([a, b]) => [a + by, b + by]);

export function checkBlack(stats: readonly FrameStats[], fps: number, from: number): CheckResult {
  const spans = runs(stats.length, (i) => stats[i].black);
  const total = spans.reduce((sum, [a, b]) => sum + b - a, 0);
  if (total === 0) return { id: 'black', status: 'pass', message: 'No black frames.', value: 0 };
  const all = total === stats.length;
  return {
    id: 'black',
    status: all ? 'fail' : 'warn',
    message: all ? 'Every frame is black.' : `${total} black ${total === 1 ? 'frame' : 'frames'}, ${seconds(total / fps)} in all.`,
    frames: shift(spans, from),
    value: round(total / fps),
  };
}

export function checkFreeze(stats: readonly FrameStats[], fps: number, from: number): CheckResult {
  // A run of same frames starts one earlier: the frame they all repeat.
  const spans = runs(stats.length, (i) => stats[i].same)
    .map(([a, b]): [number, number] => [a - 1, b])
    .filter(([a, b]) => (b - a) / fps > FREEZE_SECONDS);
  if (spans.length === 0) return { id: 'freeze', status: 'pass', message: `Nothing holds still for over ${FREEZE_SECONDS} s.`, value: 0 };
  const value = round(longest(spans) / fps);
  return { id: 'freeze', status: 'warn', message: `The picture stops for ${seconds(value)}${spans.length > 1 ? `, the longest of ${spans.length} freezes` : ''}.`, frames: shift(spans, from), value };
}

export function checkOpening(stats: readonly FrameStats[], fps: number, from: number): CheckResult {
  if (from !== 0) return { id: 'opening', status: 'pass', message: 'Skipped: this range does not start at frame 0.' };
  if (stats.length < 2) return { id: 'opening', status: 'pass', message: 'A single frame has no opening.' };
  const count = Math.min(stats.length, Math.ceil(fps * OPENING_SECONDS));
  const firstMove = stats.findIndex((s, i) => i < count && s.moved >= STATIC_SHARE);
  const still = firstMove < 0;
  if (stats[0].empty) {
    const shown = stats.findIndex((s) => !s.empty);
    const end = shown < 0 ? stats.length : shown;
    return { id: 'opening', status: 'warn', message: `The video opens on a blank frame and shows nothing for ${seconds(end / fps)}.`, frames: [[0, end]], value: round(end / fps) };
  }
  if (still) return { id: 'opening', status: 'warn', message: `Nothing moves in the first ${seconds(count / fps)}.`, frames: [[0, count]], value: round(count / fps) };
  return { id: 'opening', status: 'pass', message: 'The opening moves from the start.' };
}

export function checkLoopSeam(stats: readonly FrameStats[], seam: number, from: number, loop: boolean): CheckResult {
  const steps = stats.slice(1).map((s) => s.step).sort((a, b) => a - b);
  const typical = steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 0;
  const value = round(seam, 4);
  const percent = `${round(seam * 100, 1)}%`;
  if (!loop) return { id: 'loop-seam', status: 'pass', message: `The last frame is ${percent} away from the first. Ask for loop to judge it.`, value };
  if (seam > Math.max(SEAM_FLOOR, typical * SEAM_STEPS)) {
    return { id: 'loop-seam', status: 'warn', message: `The last frame is ${percent} away from the first, so the loop jumps.`, frames: [[from + stats.length - 1, from + stats.length]], value };
  }
  return { id: 'loop-seam', status: 'pass', message: `The last frame is ${percent} away from the first, about one ordinary step.`, value };
}

/** The frames where the picture's luminance turns round after a full swing, in order. */
function swings(stats: readonly FrameStats[]): number[] {
  const out: number[] = [];
  let peak = stats[0]?.luminance ?? 0; // the extreme since the last turn
  let direction = 0;
  stats.forEach(({ luminance }, i) => {
    const moved = luminance - peak;
    const turning = direction === 0 || Math.sign(moved) !== direction;
    if (!turning) {
      peak = luminance;
    } else if (Math.abs(moved) >= FLASH_SWING && Math.min(luminance, peak) < FLASH_DARK) {
      out.push(i);
      direction = Math.sign(moved);
      peak = luminance;
    }
  });
  return out;
}

export function checkFlashing(stats: readonly FrameStats[], fps: number, from: number): CheckResult {
  const turns = swings(stats);
  const allowed = FLASHES_PER_SECOND * 2; // swings, each flash being two
  const spans: [number, number][] = [];
  let worst = 0;
  let start = 0;
  for (let end = 0; end < turns.length; end++) {
    while (turns[end] - turns[start] >= fps) start++;
    worst = Math.max(worst, (end - start + 1) / 2);
    if (end - start + 1 <= allowed) continue;
    const span: [number, number] = [turns[start], turns[end] + 1];
    const previous = spans[spans.length - 1];
    if (previous && span[0] <= previous[1]) previous[1] = span[1];
    else spans.push(span);
  }
  const value = round(worst, 1);
  if (spans.length === 0) return { id: 'flashing', status: 'pass', message: `At most ${value} full-screen flashes a second.`, value };
  return { id: 'flashing', status: 'fail', message: `${value} full-screen flashes a second, above the limit of ${FLASHES_PER_SECOND}. This can trigger seizures.`, frames: shift(spans, from), value };
}

export function checkSparse(stats: readonly FrameStats[], fps: number, from: number): CheckResult {
  const spans = runs(stats.length, (i) => stats[i].blank).filter(([a, b]) => (b - a) / fps > SPARSE_SECONDS);
  if (spans.length === 0) return { id: 'sparse', status: 'pass', message: `No near-empty stretch over ${SPARSE_SECONDS} s.`, value: 0 };
  const value = round(longest(spans) / fps);
  return { id: 'sparse', status: 'warn', message: `The picture is nearly one colour for ${seconds(value)}.`, frames: shift(spans, from), value };
}

// ---- format ----

export function checkFormat(format: { fps: number; width: number; height: number; audio: boolean }): CheckResult {
  const { fps, width, height, audio } = format;
  const problems: string[] = [];
  if (audio && SAMPLE_RATE % fps !== 0) problems.push(`${fps} fps doesn't divide 48000, which a scene with audio needs`);
  if (width % 2 !== 0 || height % 2 !== 0) problems.push(`MP4 needs even dimensions, and this is ${width}x${height}`);
  if (problems.length > 0) return { id: 'format', status: 'fail', message: `${problems.join('; ')}.` };
  const short = width === 1080 && height === 1920;
  return { id: 'format', status: 'pass', message: `${width}x${height} at ${fps} fps${short ? ', a vertical short' : ''}.` };
}

export function checkDuration(duration: number, fps: number): CheckResult {
  const exact = duration * fps;
  const whole = Math.abs(exact - Math.round(exact)) < 1e-6;
  const frames = Math.ceil(exact - 1e-6);
  const value = round(duration, 3);
  if (!whole) return { id: 'duration', status: 'warn', message: `${value} s is not a whole number of frames at ${fps} fps, so it plays ${frames} frames.`, value };
  return { id: 'duration', status: 'pass', message: `${value} s, ${frames} frames.`, value };
}

// ---- loudness ----

// BS.1770's K-weighting at 48 kHz: a high shelf, then a high pass.
const SHELF_B = [1.53512485958697, -2.69169618940638, 1.19839281085285];
const SHELF_A = [-1.69065929318241, 0.73248077421585];
const PASS_B = [1, -2, 1];
const PASS_A = [-1.99004745483398, 0.99007225036621];
/** Gating blocks are 400 ms long, overlapping by 75%, so four hops. */
const BLOCK_HOP = 4800;
const HOPS_IN_BLOCK = 4;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

const lufsOf = (energy: number): number => -0.691 + 10 * Math.log10(energy);

/** K-weighted energy of each 100 ms hop, summed over the channels. */
function hopEnergy(channels: readonly Float32Array[]): Float64Array {
  const count = Math.floor((channels[0]?.length ?? 0) / BLOCK_HOP);
  const hops = new Float64Array(count);
  for (const samples of channels) {
    let s1 = 0;
    let s2 = 0;
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < count * BLOCK_HOP; i++) {
      const x = samples[i];
      const shelved = SHELF_B[0] * x + s1;
      s1 = SHELF_B[1] * x - SHELF_A[0] * shelved + s2;
      s2 = SHELF_B[2] * x - SHELF_A[1] * shelved;
      const y = PASS_B[0] * shelved + p1;
      p1 = PASS_B[1] * shelved - PASS_A[0] * y + p2;
      p2 = PASS_B[2] * shelved - PASS_A[1] * y;
      hops[Math.floor(i / BLOCK_HOP)] += y * y;
    }
  }
  return hops;
}

/** Integrated loudness by BS.1770-4 in LUFS, for 48 kHz audio. Null when nothing gets through the gates. */
export function integratedLoudness(channels: readonly Float32Array[]): number | null {
  const hops = hopEnergy(channels);
  const blocks: number[] = [];
  for (let i = 0; i + HOPS_IN_BLOCK <= hops.length; i++) {
    let sum = 0;
    for (let h = i; h < i + HOPS_IN_BLOCK; h++) sum += hops[h];
    blocks.push(sum / (BLOCK_HOP * HOPS_IN_BLOCK));
  }
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const loud = blocks.filter((z) => z > 0 && lufsOf(z) > ABSOLUTE_GATE);
  if (loud.length === 0) return null;
  const gate = lufsOf(mean(loud)) + RELATIVE_GATE;
  const kept = loud.filter((z) => lufsOf(z) > gate);
  return kept.length === 0 ? null : lufsOf(mean(kept));
}

const OVERSAMPLE = 4;
const PEAK_TAPS = 49;

/** A Hann-windowed sinc for 4x oversampling, split into its phases, as BS.1770's Annex 2 asks. */
const PEAK_PHASES: readonly Float64Array[] = (() => {
  const taps = Array.from({ length: PEAK_TAPS }, (_, j) => {
    const m = j - (PEAK_TAPS - 1) / 2;
    const x = (m * Math.PI) / OVERSAMPLE;
    return (m === 0 ? 1 : Math.sin(x) / x) * 0.5 * (1 - Math.cos((2 * Math.PI * j) / (PEAK_TAPS - 1)));
  });
  const gain = taps.reduce((a, b) => a + b, 0) / OVERSAMPLE;
  return Array.from({ length: OVERSAMPLE }, (_, p) => Float64Array.from(taps.filter((_, j) => j % OVERSAMPLE === p).map((c) => c / gain)));
})();

/** The true peak in dBTP, approximated by 4x oversampling. Null for silence. */
export function truePeak(channels: readonly Float32Array[]): number | null {
  let peak = 0;
  for (const samples of channels) {
    for (let n = 0; n < samples.length; n++) {
      for (let p = 0; p < OVERSAMPLE; p++) {
        const phase = PEAK_PHASES[p];
        let value = 0;
        for (let t = 0; t < phase.length && t <= n; t++) value += phase[t] * samples[n - t];
        if (value > peak) peak = value;
        else if (-value > peak) peak = -value;
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : null;
}

export function checkLoudness(lufs: number | null): CheckResult {
  const [low, high] = LUFS_RANGE;
  if (lufs === null) return { id: 'loudness', status: 'warn', message: 'The sound is too quiet or too short to measure.' };
  const value = round(lufs, 1);
  const range = `${low} to ${high}`;
  if (lufs < low) return { id: 'loudness', status: 'warn', message: `${value} LUFS, quieter than ${range}.`, value };
  if (lufs > high) return { id: 'loudness', status: 'warn', message: `${value} LUFS, louder than ${range}.`, value };
  return { id: 'loudness', status: 'pass', message: `${value} LUFS, inside ${range}.`, value };
}

export function checkTruePeak(dbtp: number | null): CheckResult {
  if (dbtp === null) return { id: 'true-peak', status: 'pass', message: 'No peaks: the sound is silent.' };
  const value = round(dbtp, 1);
  if (dbtp > TRUE_PEAK_LIMIT) return { id: 'true-peak', status: 'warn', message: `Peaks at ${value} dBTP, above ${TRUE_PEAK_LIMIT}. It may clip once encoded.`, value };
  return { id: 'true-peak', status: 'pass', message: `Peaks at ${value} dBTP.`, value };
}

// ---- dropouts and onsets ----

/** Dropouts look at the loudest sample of every 10 ms. */
const SILENCE_BLOCK = 480;

/** Silences over a second between two sounds, as [from, to) sample ranges. */
export function findDropouts(channels: readonly Float32Array[]): [number, number][] {
  const limit = 10 ** (SILENCE_DB / 20);
  const length = channels[0]?.length ?? 0;
  const blocks = Math.ceil(length / SILENCE_BLOCK);
  const out: [number, number][] = [];
  let lastLoud = -1;
  for (let block = 0; block < blocks; block++) {
    const start = block * SILENCE_BLOCK;
    const end = Math.min(length, start + SILENCE_BLOCK);
    let loud = false;
    for (const samples of channels) {
      for (let i = start; i < end && !loud; i++) loud = Math.abs(samples[i]) >= limit;
    }
    if (!loud) continue;
    const gap = (block - lastLoud - 1) * SILENCE_BLOCK;
    if (lastLoud >= 0 && gap / SAMPLE_RATE > DROPOUT_SECONDS) out.push([(lastLoud + 1) * SILENCE_BLOCK, start]);
    lastLoud = block;
  }
  return out;
}

export function checkDropouts(channels: readonly Float32Array[], fps: number, from: number): CheckResult {
  const gaps = findDropouts(channels);
  if (gaps.length === 0) return { id: 'dropouts', status: 'pass', message: 'No silence over 1 s between sounds.', value: 0 };
  const perFrame = SAMPLE_RATE / fps;
  const value = round(longest(gaps) / SAMPLE_RATE);
  return {
    id: 'dropouts',
    status: 'warn',
    message: `${gaps.length === 1 ? 'The sound stops' : `${gaps.length} silences between sounds, the longest`} for ${seconds(value)}${gaps.length === 1 ? ' and comes back' : ''}.`,
    frames: gaps.map(([a, b]) => [from + Math.floor(a / perFrame), from + Math.ceil(b / perFrame)]),
    value,
  };
}

// Onsets: a 20 ms window against the 100 ms before it, every 5 ms.
const ONSET_HOP = 240;
const ONSET_WINDOW = 4;
const ONSET_BASELINE = 20;
/** The window must hold this many times the energy before it: 6 dB. */
const ONSET_RISE = 4;
/** And be at least this loud, in dB, so a noise floor can't start anything. */
const ONSET_FLOOR_DB = -50;
/** Hops to wait after an onset: its own attack isn't another. */
const ONSET_HOLD = 10;

/** Where sounds start, in seconds, in time order. Each time is the end of the 5 ms it shows in, so a sound that starts on a frame stays on it. */
export function detectOnsets(channels: readonly Float32Array[]): number[] {
  const count = Math.floor((channels[0]?.length ?? 0) / ONSET_HOP);
  const energy = new Float64Array(count);
  for (const samples of channels) {
    for (let i = 0; i < count * ONSET_HOP; i++) energy[Math.floor(i / ONSET_HOP)] += samples[i] * samples[i];
  }
  const floor = 10 ** (ONSET_FLOOR_DB / 10) * ONSET_HOP * ONSET_WINDOW;
  const sum = (from: number, to: number) => {
    let total = 0;
    for (let k = Math.max(0, from); k < to; k++) total += energy[k];
    return total;
  };
  const out: number[] = [];
  let next = 0;
  for (let k = 0; k < count; k++) {
    if (k < next) continue;
    const window = sum(k - ONSET_WINDOW + 1, k + 1);
    const before = (sum(k - ONSET_WINDOW + 1 - ONSET_BASELINE, k - ONSET_WINDOW + 1) * ONSET_WINDOW) / ONSET_BASELINE;
    if (window < floor || window < before * ONSET_RISE) continue;
    out.push(((k + 1) * ONSET_HOP) / SAMPLE_RATE);
    next = k + ONSET_HOLD;
  }
  return out;
}

export interface CheckMarker {
  t: number;
  label: string;
}

export function checkMarkers(markers: readonly CheckMarker[], onsets: readonly number[], fps: number, from: number, to: number): CheckResult {
  const frameOf = (t: number) => Math.floor(t * fps + 1e-6);
  const sync = markers.filter((m) => m.label.trimEnd().endsWith('!') && frameOf(m.t) >= from && frameOf(m.t) < to);
  if (sync.length === 0) return { id: 'markers', status: 'pass', message: 'No sync markers to check.', value: 0 };
  const misses: { frame: number; message: string }[] = [];
  for (const marker of sync) {
    const frame = frameOf(marker.t);
    const nearest = onsets.map(frameOf).reduce<number | null>((best, f) => (best === null || Math.abs(f - frame) < Math.abs(best - frame) ? f : best), null);
    if (nearest !== null && Math.abs(nearest - frame) <= MARKER_FRAMES) continue;
    misses.push({ frame, message: `"${marker.label}" at frame ${frame} has no sound starting within ${MARKER_FRAMES} frames${nearest === null ? '' : `; the nearest is at frame ${nearest}`}` });
  }
  if (misses.length === 0) return { id: 'markers', status: 'pass', message: `${sync.length} sync ${sync.length === 1 ? 'marker has' : 'markers have'} a sound on time.`, value: 0 };
  return { id: 'markers', status: 'fail', message: `${misses.map((m) => m.message).join('. ')}.`, frames: misses.map((m) => [m.frame, m.frame + 1]), value: misses.length };
}

// ---- the whole report ----

export interface CheckInput {
  /** The scene or composition id. */
  scene: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  /** The frames measured: [from, to). */
  from: number;
  to: number;
  frames: FrameMeter;
  /** Judge the seam between the last frame and the first. */
  loop?: boolean;
  markers?: readonly CheckMarker[];
  /**
   * The whole scene's rendered audio at 48 kHz, one array per channel. Null for a silent scene.
   * A string says why it could not be rendered.
   */
  audio: readonly Float32Array[] | string | null;
}

function checkSound(input: CheckInput): CheckResult[] {
  const { audio, fps, from, to } = input;
  const markers = input.markers ?? [];
  if (typeof audio === 'string') return [{ id: 'loudness', status: 'fail', message: audio }];
  if (audio === null) {
    const none = (id: string): CheckResult => ({ id, status: 'pass', message: 'The video has no sound.' });
    return [none('loudness'), none('true-peak'), none('dropouts'), checkMarkers(markers, [], fps, from, to)];
  }
  const perFrame = SAMPLE_RATE / fps;
  const range = audio.map((samples) => samples.subarray(from * perFrame, to * perFrame));
  return [
    checkLoudness(integratedLoudness(range)),
    checkTruePeak(truePeak(range)),
    checkDropouts(range, fps, from),
    // The whole scene, so a marker near the range's start sees what was playing before it.
    checkMarkers(markers, detectOnsets(audio), fps, from, to),
  ];
}

/** Every check, in the order a person reads them. `ok` is false when any failed. */
export function buildReport(input: CheckInput): CheckReport {
  const { fps, from, to, frames } = input;
  const { stats, seam } = frames;
  const checks = [
    checkFormat({ fps, width: input.width, height: input.height, audio: input.audio !== null }),
    checkDuration(input.duration, fps),
    checkBlack(stats, fps, from),
    checkFreeze(stats, fps, from),
    checkOpening(stats, fps, from),
    checkLoopSeam(stats, seam, from, input.loop === true),
    checkFlashing(stats, fps, from),
    checkSparse(stats, fps, from),
    ...checkSound(input),
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), scene: input.scene, from, to, checks };
}
