// The checks that read words (ADR 0016): do anchors sit on their words, has any
// lost its word, can captions be read in the time they stay up, and do they stay
// inside the safe area. Numbers from the scene alone, so no pixels are drawn
// here. Never imported by the runtime.

import { quantizeTime } from '../engine/time';
import { stageSize } from '../engine/pixel';
import { resolveLayer, sceneLayers } from '../engine/resolve';
import { safeArea } from '../engine/safe-area';
import { parseWordRef, sceneWords, unanchoredWords, wordTime } from '../engine/speech';
import type { Layer, RigRegistry, Scene, World } from '../engine/types';
import { layoutCaptions, type CaptionCase, type CaptionPage, type CaptionPosition } from '../rigs/type/caption-layout';
import type { CheckResult } from './check';

/** Characters a second, spaces included, that a viewer can read. Subtitling's usual ceilings for grown-ups: English reads faster than Spanish. */
const READING_SPEED: Readonly<Record<string, number>> = { en: 20, es: 17 };
const DEFAULT_READING_SPEED = 20;
/** A page shorter than this is read at a glance, whatever the arithmetic says. */
const GLANCE_SECONDS = 0.5;
/** An anchor may land this many frames from its word: as near as the check asks of a sync marker. */
const SYNC_FRAMES = 2;
/** Timing the job wasn't sure of, under something that depends on it. */
const UNSURE = 0.5;
/** A block may sit this far past the safe edge in stage pixels before it counts. */
const SAFE_SLACK = 0.5;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Anchor {
  label: string;
  word: string;
  t: number;
  /** The frame it shows on, which a stepFps layer can hold back. */
  frame: number;
}

function anchors(scene: Scene): Anchor[] {
  const { fps } = scene;
  const out: Anchor[] = (scene.markers ?? []).flatMap((m) => (m.word ? [{ label: `marker "${m.label}"`, word: m.word, t: m.t, frame: Math.floor(m.t * fps + 1e-6) }] : []));
  for (const layer of sceneLayers(scene)) {
    for (const track of layer.tracks ?? []) {
      for (const key of track.keys) {
        if (!key.word) continue;
        let frame = Math.floor(key.t * fps + 1e-6);
        // A held layer shows a key on the first frame whose held time reaches it.
        if (layer.stepFps !== undefined) while (quantizeTime(frame, fps, layer.stepFps) < key.t - 1e-6) frame++;
        out.push({ label: `${layer.id}'s ${track.param}`, word: key.word, t: key.t, frame });
      }
    }
  }
  return out;
}

/** Anchored keys and markers against their words. */
export function checkWordSync(scene: Scene, from: number, to: number): CheckResult {
  const { fps } = scene;
  const inRange = anchors(scene).filter((a) => a.frame >= from && a.frame < to);
  const placed = inRange.filter((a) => wordTime(scene, a.word) !== null);
  if (placed.length === 0) return { id: 'word-sync', status: 'pass', message: 'Nothing is anchored to a word.', value: 0 };
  const late = placed.filter((a) => Math.abs(a.frame - Math.floor(wordTime(scene, a.word)! * fps + 1e-6)) > SYNC_FRAMES);
  if (late.length > 0) {
    return {
      id: 'word-sync',
      status: 'fail',
      message: `${late.map((a) => `${a.label} shows on frame ${a.frame}, more than ${SYNC_FRAMES} frames from ${a.word}`).join('. ')}.`,
      frames: late.map((a) => [a.frame, a.frame + 1]),
      value: late.length,
    };
  }
  const unsure = placed.filter((a) => {
    const ref = parseWordRef(a.word)!;
    return (sceneWords(scene, ref.cue).find((w) => w.id === ref.word)?.p ?? 1) < UNSURE;
  });
  if (unsure.length > 0) {
    return {
      id: 'word-sync',
      status: 'warn',
      message: `${unsure.map((a) => `${a.label} is on ${a.word}, whose timing is a guess`).join('. ')}. Listen to it, or drag the word.`,
      frames: unsure.map((a) => [a.frame, a.frame + 1]),
      value: unsure.length,
    };
  }
  return { id: 'word-sync', status: 'pass', message: `${plural(placed.length, 'anchor sits', 'anchors sit')} on ${placed.length === 1 ? 'its word' : 'their words'}.`, value: 0 };
}

/** Anchors a re-record or a trim left without a word. */
export function checkOrphans(scene: Scene): CheckResult {
  const orphans = unanchoredWords(scene);
  if (orphans.length === 0) return { id: 'word-orphans', status: 'pass', message: 'Every anchor has its word.', value: 0 };
  return {
    id: 'word-orphans',
    status: 'warn',
    message: `${orphans.map((o) => `${o.where} lost ${o.word} and stays at ${o.t} s`).join('. ')}. Anchor each to a word, or remove its word.`,
    value: orphans.length,
  };
}

interface CaptionLayer {
  id: string;
  cue: string;
  pages: CaptionPage[];
}

/** Each captions layer of the scene, with what it would put on screen. */
function captionLayers(scene: Scene, registry: RigRegistry, world: World): CaptionLayer[] {
  const [width, height] = stageSize(scene);
  return sceneLayers(scene).flatMap((layer: Layer) => {
    if (layer.scene !== undefined || layer.file !== undefined) return [];
    let params;
    try {
      const resolved = resolveLayer(layer, scene, 0, registry, world);
      if (resolved.rig.id !== 'captions') return [];
      params = resolved.params;
    } catch {
      return [];
    }
    const cue = String(params.cue);
    const { pages } = layoutCaptions(
      sceneWords(scene, cue),
      {
        font: String(params.font),
        size: Number(params.size),
        lines: Math.round(Number(params.lines)),
        width: Number(params.width),
        position: String(params.position) as CaptionPosition,
        offsetX: Number(params.offsetX),
        offsetY: Number(params.offsetY),
        letterCase: String(params.case) as CaptionCase,
      },
      { width, height },
    );
    return [{ id: layer.id, cue, pages }];
  });
}

const pageFrames = (page: CaptionPage, fps: number): [number, number] => [Math.floor(page.start * fps + 1e-6), Math.max(Math.floor(page.start * fps + 1e-6) + 1, Math.ceil(page.end * fps - 1e-6))];

function readingLimit(scene: Scene, cueId: string): number {
  return READING_SPEED[scene.audio?.find((cue) => cue.id === cueId)?.lang ?? ''] ?? DEFAULT_READING_SPEED;
}

/** Whether each page of captions stays up long enough to read. Spanish gets the slower ceiling. */
export function checkReadingSpeed(scene: Scene, layers: readonly CaptionLayer[], from: number, to: number): CheckResult {
  const { fps } = scene;
  const fast: { id: string; text: string; speed: number; limit: number; frames: [number, number] }[] = [];
  let fastest = 0;
  for (const layer of layers) {
    const limit = readingLimit(scene, layer.cue);
    for (const page of layer.pages) {
      const frames = pageFrames(page, fps);
      if (frames[1] <= from || frames[0] >= to) continue;
      const text = page.words.map((w) => w.text).join(' ');
      const speed = [...text].length / Math.max(GLANCE_SECONDS, page.end - page.start);
      fastest = Math.max(fastest, speed);
      if (speed > limit) fast.push({ id: layer.id, text, speed, limit, frames });
    }
  }
  const value = Number(fastest.toFixed(1));
  if (layers.length === 0) return { id: 'caption-speed', status: 'pass', message: 'There are no captions.', value: 0 };
  if (fast.length === 0) return { id: 'caption-speed', status: 'pass', message: `Captions read at up to ${value} characters a second.`, value };
  return {
    id: 'caption-speed',
    status: 'warn',
    message: `${fast.map((f) => `"${f.text}" asks for ${f.speed.toFixed(1)} characters a second, over ${f.limit}`).join('. ')}. Give those pages fewer words, or the voice more time.`,
    frames: fast.map((f) => f.frames),
    value,
  };
}

/** Whether captions stay where a platform's interface won't cover them, and whether they have any words to show. */
export function checkCaptionSafe(scene: Scene, layers: readonly CaptionLayer[], from: number, to: number): CheckResult {
  const { fps } = scene;
  const [width, height] = stageSize(scene);
  const area = safeArea(width, height);
  if (layers.length === 0) return { id: 'caption-safe', status: 'pass', message: 'There are no captions.', value: 0 };
  const silent = layers.filter((l) => l.pages.length === 0);
  if (silent.length > 0) {
    return { id: 'caption-safe', status: 'fail', message: `${silent.map((l) => `Captions "${l.id}" read cue "${l.cue}", which has no words`).join('. ')}. Run align_voice on it.`, value: silent.length };
  }
  const out: { id: string; text: string; frames: [number, number] }[] = [];
  for (const layer of layers) {
    for (const page of layer.pages) {
      const frames = pageFrames(page, fps);
      if (frames[1] <= from || frames[0] >= to) continue;
      const { x, y, width: w, height: h } = page.box;
      const inside = x >= area.x - SAFE_SLACK && y >= area.y - SAFE_SLACK && x + w <= area.x + area.width + SAFE_SLACK && y + h <= area.y + area.height + SAFE_SLACK;
      if (!inside) out.push({ id: layer.id, text: page.words.map((word) => word.text).join(' '), frames });
    }
  }
  if (out.length === 0) return { id: 'caption-safe', status: 'pass', message: 'Captions stay inside the safe area.', value: 0 };
  return {
    id: 'caption-safe',
    status: 'warn',
    message: `${out.map((o) => `"${o.text}" leaves the safe area`).join('. ')}.`,
    frames: out.map((o) => o.frames),
    value: out.length,
  };
}

/** Every word check, for the report. */
export function speechChecks(scene: Scene, registry: RigRegistry, world: World, from: number, to: number): CheckResult[] {
  const layers = captionLayers(scene, registry, world);
  return [checkWordSync(scene, from, to), checkOrphans(scene), checkReadingSpeed(scene, layers, from, to), checkCaptionSafe(scene, layers, from, to)];
}
