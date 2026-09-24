// Editing scene data: JSON merge patches, scoped overrides for a selection,
// and the file format scenes are written in. Pure. The MCP server uses these
// now and the viewer's editing UI can later; the embed never imports them.

import { BACKGROUND_ID, type Layer, type LayerSpec, type Override, type Params, type Scene } from './types';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * RFC 7386 JSON merge patch: objects merge key by key, null deletes a key,
 * and anything else, arrays included, replaces the target. Returns a new
 * value and leaves both inputs alone.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** What apply_to_selection changes over the selected frames: a rig variant, params, or both. */
export interface SelectionPatch {
  rig?: string;
  params?: Params;
}

export interface EditSelection {
  layerId?: string;
  /** Accepted for the selection's shape; params apply to the whole layer. */
  partId?: string;
  from: number;
  to: number;
}

function withPatch(from: number, to: number, patch: SelectionPatch, over?: Override): Override {
  const rig = patch.rig ?? over?.rig;
  const params = { ...over?.params, ...patch.params };
  return { from, to, ...(rig !== undefined ? { rig } : {}), ...(Object.keys(params).length > 0 ? { params } : {}) };
}

/**
 * The scene with `patch` applied to the selected layer over frames
 * [from, to), as overrides. Overrides the range partly covers are split, so
 * they still apply outside it, and inside it the patch lands on top of them.
 * The result never has overlapping overrides. Returns a new scene.
 */
export function applyToSelection(scene: Scene, selection: EditSelection, patch: SelectionPatch): Scene {
  const { layerId, from, to } = selection;
  if (layerId === undefined) {
    throw new Error('apply_to_selection needs a layerId; to change every layer over a range, apply to each layer');
  }
  if (patch.rig === undefined && Object.keys(patch.params ?? {}).length === 0) {
    throw new Error('the patch must set a rig or params');
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to)) {
    throw new RangeError(`the range needs integer frames with 0 <= from < to, got [${from}, ${to})`);
  }
  const out = structuredClone(scene);
  const layer: LayerSpec | Layer | undefined = layerId === BACKGROUND_ID ? out.background : out.layers.find((l) => l.id === layerId);
  if (!layer) {
    const ids = [...out.layers.map((l) => l.id), ...(out.background ? [BACKGROUND_ID] : [])];
    throw new Error(`no layer "${layerId}" in scene "${scene.id}"; layers: ${ids.join(', ')}`);
  }

  const result: Override[] = [];
  let cursor = from;
  for (const o of [...(layer.overrides ?? [])].sort((a, b) => a.from - b.from)) {
    if (o.to <= from || o.from >= to) {
      result.push(o);
      continue;
    }
    if (o.from < from) result.push({ ...o, to: from });
    if (o.to > to) result.push({ ...o, from: to });
    const start = Math.max(o.from, from);
    const end = Math.min(o.to, to);
    if (cursor < start) result.push(withPatch(cursor, start, patch));
    result.push(withPatch(start, end, patch, o));
    cursor = end;
  }
  if (cursor < to) result.push(withPatch(cursor, to, patch));
  layer.overrides = result.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * Scene files as the studio writes them: two-space indents, and any object or
 * array that fits within `width` columns kept on one line, so small edits
 * make small diffs. Ends with a newline.
 */
export function formatSceneJson(value: unknown, width = 100): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (isObject(v)) {
      const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    }
    return JSON.stringify(v);
  };
  const block = (v: unknown, indent: string, prefix: number): string => {
    const one = inline(v);
    const container = Array.isArray(v) ? v.length > 0 : isObject(v) && Object.keys(v).length > 0;
    // +1 leaves room for a trailing comma.
    if (!container || indent.length + prefix + one.length + 1 <= width) return one;
    const inner = `${indent}  `;
    if (Array.isArray(v)) return `[\n${v.map((x) => inner + block(x, inner, 0)).join(',\n')}\n${indent}]`;
    const lines = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return inner + key + block(x, inner, key.length);
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  };
  return `${block(value, '', 0)}\n`;
}
