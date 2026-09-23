/**
 * Test helpers for rigs that declare parts. Test-only: nothing in the runtime
 * imports this file.
 *
 * drawRecorded draws a rig through the engine's recording context with a kit
 * that writes a marker into the log at every part boundary, so a test can see
 * which part each canvas call belongs to. Reading ctx.canvas throws.
 */
import { PASS_THROUGH, onlyParts } from '../../engine/kit';
import { defaultParams } from '../../engine/registry';
import { createRng } from '../../engine/rng';
import { createRecordingContext, type LogEntry } from '../../engine/testing/recording-context';
import type { DrawKit, Params, Rig, Stage } from '../../engine/types';

export const STAGE: Stage = { width: 1920, height: 1080 };

/** The marker the kit writes: begin or end of a part. */
export const MARK = '#part';

/** Calls that put pixels on the canvas. */
export const PAINT_CALLS = new Set([
  'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'clearRect', 'putImageData',
]);

/** Blend modes that never read the destination beyond ordinary blending (rule 4). */
export const ALLOWED_COMPOSITES = new Set([
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
  'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

export interface Recorded {
  log: LogEntry[];
  /** Problems the kit saw: nested parts, or part ids the rig does not declare. */
  kitErrors: string[];
  saveDepth: number;
}

export interface DrawOptions {
  params?: Params;
  t?: number;
  seed?: number;
  key?: string;
  stage?: Stage;
  /** Draw only these parts (onlyParts). Default: every part. */
  only?: readonly string[];
}

export function drawRecorded(rig: Rig, o: DrawOptions = {}): Recorded {
  const rec = createRecordingContext();
  const ctx = new Proxy(rec.ctx, {
    get(target, prop, receiver) {
      if (prop === 'canvas') throw new Error(`${rig.id} read ctx.canvas; rigs must use the stage argument`);
      return Reflect.get(target, prop, receiver);
    },
  });
  const inner = o.only ? onlyParts(o.only) : PASS_THROUGH;
  const declared = new Set(rig.parts ?? []);
  const kitErrors: string[] = [];
  let inside: string | undefined;
  const kit: DrawKit = {
    part(id, draw) {
      if (inside !== undefined) kitErrors.push(`part "${id}" opened inside part "${inside}"`);
      if (!declared.has(id)) kitErrors.push(`part "${id}" is not in ${rig.id}.parts`);
      rec.log.push({ op: 'call', name: MARK, args: [id, 'begin'] });
      const outer = inside;
      inside = id;
      try {
        inner.part(id, draw);
      } finally {
        inside = outer;
        rec.log.push({ op: 'call', name: MARK, args: [id, 'end'] });
      }
    },
  };
  const params = { ...defaultParams(rig), ...o.params };
  rig.draw(ctx, params, o.t ?? 0, createRng(o.seed ?? 42, o.key ?? 'layer'), o.stage ?? STAGE, kit);
  return { log: rec.log, kitErrors, saveDepth: rec.saveDepth() };
}

const isMark = (e: LogEntry) => e.op === 'call' && e.name === MARK;

/** The part each entry sits in (undefined outside parts), markers dropped. */
export function withParts(log: readonly LogEntry[]): { entry: LogEntry; part: string | undefined }[] {
  const out: { entry: LogEntry; part: string | undefined }[] = [];
  let part: string | undefined;
  for (const entry of log) {
    if (isMark(entry)) {
      const [id, edge] = (entry as { args: unknown[] }).args as [string, string];
      part = edge === 'begin' ? id : undefined;
      continue;
    }
    out.push({ entry, part });
  }
  return out;
}

/** Entries inside any segment of `part`, in order. */
export function partEntries(log: readonly LogEntry[], part: string): LogEntry[] {
  return withParts(log).filter((x) => x.part === part).map((x) => x.entry);
}

/** The log with every segment of `part` removed, and the markers dropped. */
export function withoutPart(log: readonly LogEntry[], part: string): LogEntry[] {
  return withParts(log).filter((x) => x.part !== part).map((x) => x.entry);
}

/** The log with the markers dropped: what the plain render would record. */
export function unmarked(log: readonly LogEntry[]): LogEntry[] {
  return log.filter((e) => !isMark(e));
}

export function isPaint(entry: LogEntry): boolean {
  return entry.op === 'call' && PAINT_CALLS.has(entry.name);
}

const COMMON = [
  'globalAlpha', 'globalCompositeOperation', 'filter', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
  'imageSmoothingEnabled', 'imageSmoothingQuality',
];
const FILL = ['fillStyle'];
const STROKE = ['strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset'];
const TEXT = ['font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering'];

/** The drawing-state properties that decide what a paint call puts on the canvas. */
function relevantProps(name: string): string[] {
  switch (name) {
    case 'fill':
    case 'fillRect':
      return [...COMMON, ...FILL];
    case 'stroke':
    case 'strokeRect':
      return [...COMMON, ...STROKE];
    case 'fillText':
      return [...COMMON, ...FILL, ...TEXT];
    case 'strokeText':
      return [...COMMON, ...STROKE, ...TEXT];
    default:
      return COMMON;
  }
}

/**
 * The marks a list of entries paints, as a comparable string. Each paint call
 * keeps its args, transform, clips, path and the state properties that affect
 * it; a lineCap left over from an earlier part does not change a fill, so it
 * is left out. Two equal results paint the same pixels.
 */
export function marksOf(entries: readonly LogEntry[]): string {
  const out: unknown[] = [];
  for (const e of entries) {
    if (!isPaint(e) || e.op !== 'call') continue;
    const paint = e.paint;
    const props: Record<string, unknown> = {};
    if (paint?.props) for (const k of relevantProps(e.name)) props[k] = paint.props[k];
    out.push({
      name: e.name,
      args: e.args,
      props,
      transform: paint?.transform,
      lineDash: e.name.startsWith('stroke') ? paint?.lineDash : undefined,
      clips: paint?.clips,
      path: paint?.path,
    });
  }
  return JSON.stringify(out);
}
