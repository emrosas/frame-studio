import { isCssColor } from './color';
import { EASING_NAMES } from './easing';
import { baseRigId, variantsOf } from './registry';
import { frameCount, quantizeTime } from './time';
import { BACKGROUND_ID, type ParamSpec, type Rig, type RigRegistry, type Scene } from './types';

export type ValidationResult = { ok: true; scene: Scene } | { ok: false; errors: string[] };

/**
 * Check an untrusted scene (e.g. parsed JSON). Collects every problem as
 * "path: message", with paths like layers[1].tracks[0].keys[2].t, and
 * messages that say how to fix it. With a registry it also checks rig ids,
 * param names, and param value types against each rig's schema.
 */
export function validateScene(input: unknown, registry?: RigRegistry): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`);

  if (!isObject(input)) {
    err('scene', `must be an object like { id, fps, duration, size, seed, layers }, got ${show(input)}`);
    return { ok: false, errors };
  }
  const s = input;
  checkFields(err, s, '', SCENE_FIELDS);

  if (!isNonEmptyString(s.id)) err('id', `must be a non-empty string, got ${show(s.id)}`);

  const fpsOk = typeof s.fps === 'number' && Number.isInteger(s.fps) && s.fps > 0;
  if (!fpsOk) err('fps', `must be a positive integer (frames per second, e.g. 12, 24, 30), got ${show(s.fps)}`);
  const fps = fpsOk ? (s.fps as number) : undefined;

  const durationOk = typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0;
  if (!durationOk) err('duration', `must be a positive finite number of seconds, got ${show(s.duration)}`);

  const frames = fps !== undefined && durationOk ? frameCount({ fps, duration: s.duration as number }) : undefined;
  if (frames !== undefined && frames < 1) {
    err('duration', `too short: gives 0 frames at ${fps} fps; use at least 1/${fps} s`);
  }

  if (!(Array.isArray(s.size) && s.size.length === 2 && s.size.every(isPositiveInteger))) {
    err('size', `must be two positive integers [width, height] in scene pixels, e.g. [1920, 1080], got ${show(s.size)}`);
  }

  if (!(typeof s.seed === 'number' && Number.isInteger(s.seed))) {
    err('seed', `must be an integer, got ${show(s.seed)}`);
  }

  const rigNames = registry ? [...registry.keys()].sort().map((k) => JSON.stringify(k)).join(', ') || '(none)' : '';

  const env: Env = { err, registry, rigNames, fps, frames };

  if (s.background !== undefined) {
    if (!isObject(s.background)) {
      err('background', `must be an object like { "rig": "paper", "params": {...} }, got ${show(s.background)}`);
    } else {
      if (s.background.id !== undefined) {
        err('background.id', `the background's id is always "${BACKGROUND_ID}"; remove this field`);
      }
      checkFields(err, s.background, 'background', BACKGROUND_FIELDS, 'id');
      checkLayerSpec(env, s.background, 'background');
    }
  }

  if (!Array.isArray(s.layers)) {
    err('layers', `must be an array of layers (use [] for none), got ${show(s.layers)}`);
  } else {
    const seen = new Map<string, number>();
    s.layers.forEach((layer: unknown, i: number) => {
      const path = `layers[${i}]`;
      if (!isObject(layer)) {
        err(path, `must be an object like { "id": "...", "rig": "..." }, got ${show(layer)}`);
        return;
      }
      if (!isNonEmptyString(layer.id)) {
        err(`${path}.id`, `must be a non-empty string, got ${show(layer.id)}`);
      } else if (layer.id === BACKGROUND_ID) {
        err(`${path}.id`, `"${BACKGROUND_ID}" is reserved for scene.background; pick another layer id`);
      } else if (layer.id.includes('/')) {
        err(`${path}.id`, `layer ids may not contain "/" (it separates RNG fork keys), got ${show(layer.id)}`);
      } else if (seen.has(layer.id)) {
        err(`${path}.id`, `duplicate layer id "${layer.id}" (also used by layers[${seen.get(layer.id)}]); layer ids must be unique`);
      } else {
        seen.set(layer.id, i);
      }
      checkFields(err, layer, path, LAYER_FIELDS);
      checkLayerSpec(env, layer, path);
    });
  }

  if (s.audio !== undefined) checkAudio(env, s.audio);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, scene: input as unknown as Scene };
}

interface Env {
  err: (path: string, message: string) => void;
  registry: RigRegistry | undefined;
  rigNames: string;
  fps: number | undefined;
  frames: number | undefined;
}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isParamValue(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/** A short description of a bad value for error messages. */
function show(v: unknown): string {
  if (v === undefined) return 'undefined (missing)';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array ${truncate(safeJson(v))}`;
  if (typeof v === 'string') return `string ${truncate(JSON.stringify(v))}`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v} ${String(v)}`;
  if (typeof v === 'object') return `an object ${truncate(safeJson(v))}`;
  return typeof v;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const SCENE_FIELDS = ['id', 'fps', 'duration', 'size', 'seed', 'background', 'layers', 'audio'];
const LAYER_FIELDS = ['id', 'rig', 'params', 'tracks', 'stepFps', 'overrides'];
/** The background is a layer without an id; background.id gets its own message. */
const BACKGROUND_FIELDS = LAYER_FIELDS.filter((f) => f !== 'id');
const TRACK_FIELDS = ['param', 'keys'];
const KEY_FIELDS = ['t', 'v', 'ease'];
const OVERRIDE_FIELDS = ['from', 'to', 'rig', 'params'];
const AUDIO_FIELDS = ['id', 'generator', 'start', 'end', 'params'];
/** Misspellings too far from the right name for the edit-distance hint. */
const FIELD_ALIASES: Readonly<Record<string, string>> = { easing: 'ease' };

/**
 * Report every field the format does not define. Without this a typo such as
 * "stepfps" or "easing" would be ignored and the scene would render wrong
 * with no error.
 */
function checkFields(err: Env['err'], obj: Obj, path: string, allowed: readonly string[], skip?: string): void {
  for (const name of Object.keys(obj)) {
    if (name === skip || allowed.includes(name)) continue;
    const guess = suggestField(name, allowed);
    const hint = guess ? ` did you mean "${guess}"?` : '';
    err(path ? `${path}.${name}` : name, `unknown field "${name}";${hint} allowed fields: ${allowed.join(', ')}`);
  }
}

function suggestField(name: string, allowed: readonly string[]): string | undefined {
  const alias = Object.hasOwn(FIELD_ALIASES, name) ? FIELD_ALIASES[name] : undefined;
  if (alias && allowed.includes(alias)) return alias;
  const lower = name.toLowerCase();
  const limit = name.length >= 5 ? 2 : 1;
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const field of allowed) {
    const d = editDistance(lower, field.toLowerCase());
    if (d < bestDistance) {
      best = field;
      bestDistance = d;
    }
  }
  return best;
}

/** Levenshtein distance. Field names are short, so the simple table is fine. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Look up a rig id, reporting unknown ids. Returns the rig only when there is a registry and it knows the id. */
function lookupRig(env: Env, rigId: unknown, path: string): Rig | undefined {
  if (!env.registry || !isNonEmptyString(rigId)) return undefined;
  const rig = env.registry.get(rigId);
  if (!rig) env.err(path, `unknown rig "${rigId}"; known rigs: ${env.rigNames}`);
  return rig;
}

function unknownParam(rig: Rig, name: string): string {
  const known = Object.keys(rig.params);
  return known.length > 0
    ? `unknown param "${name}" for rig "${rig.id}"; known params: ${known.join(', ')}`
    : `unknown param "${name}": rig "${rig.id}" takes no params`;
}

/** Why a value does not fit a param spec, or undefined if it fits. */
function typeMismatch(spec: ParamSpec, v: unknown, rig: Rig, name: string): string | undefined {
  const who = `rig "${rig.id}" param "${name}"`;
  switch (spec.type) {
    case 'number':
      return typeof v === 'number' ? undefined : `${who} expects a number, got ${show(v)}`;
    case 'string':
      return typeof v === 'string' ? undefined : `${who} expects a string, got ${show(v)}`;
    case 'color':
      if (typeof v !== 'string') return `${who} expects a color string such as "#ff8800", got ${show(v)}`;
      return isCssColor(v)
        ? undefined
        : `${truncate(JSON.stringify(v))} is not a CSS color for ${who}; use a hex code such as "#ff8800", a named color such as "tomato", a function such as "rgb(255 136 0)" or "oklch(70% 0.1 200)", or "none"`;
    case 'boolean':
      return typeof v === 'boolean' ? undefined : `${who} expects a boolean (true or false), got ${show(v)}`;
    case 'enum': {
      const options = spec.options.map((o) => JSON.stringify(o)).join(', ');
      if (typeof v !== 'string') return `${who} expects one of ${options}, got ${show(v)}`;
      return spec.options.includes(v) ? undefined : `"${v}" is not an option for ${who}; options: ${options}`;
    }
  }
}

/** The rig's spec for a param name. Own keys only, so "toString" or "constructor" are not params. */
function specOf(rig: Rig, name: string): ParamSpec | undefined {
  return Object.hasOwn(rig.params, name) ? rig.params[name] : undefined;
}

function checkParams(env: Env, params: unknown, path: string, rig: Rig | undefined): void {
  if (params === undefined) return;
  if (!isObject(params)) {
    env.err(path, `must be an object mapping param names to values, got ${show(params)}`);
    return;
  }
  for (const [name, v] of Object.entries(params)) {
    const p = `${path}.${name}`;
    if (!isParamValue(v)) {
      env.err(p, `must be a finite number, string, or boolean, got ${show(v)}`);
      continue;
    }
    if (!rig) continue;
    const spec = specOf(rig, name);
    const problem = spec ? typeMismatch(spec, v, rig, name) : unknownParam(rig, name);
    if (problem) env.err(p, problem);
  }
}

function checkLayerSpec(env: Env, layer: Obj, path: string): void {
  const { err } = env;

  if (!isNonEmptyString(layer.rig)) err(`${path}.rig`, `must be a non-empty string (a rig id), got ${show(layer.rig)}`);
  const rig = lookupRig(env, layer.rig, `${path}.rig`);

  if (layer.stepFps !== undefined) {
    const v = layer.stepFps;
    const max = env.fps ?? Infinity;
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max)) {
      const bound = env.fps !== undefined ? `${env.fps} (the scene fps)` : 'the scene fps';
      err(`${path}.stepFps`, `must be a number with 0 < stepFps <= ${bound}; omit it to move every frame; got ${show(v)}`);
    }
  }

  checkParams(env, layer.params, `${path}.params`, rig);
  checkTracks(env, layer.tracks, `${path}.tracks`, rig);
  checkOverrides(env, layer, path, rig);
}

function checkTracks(env: Env, tracks: unknown, path: string, rig: Rig | undefined): void {
  const { err } = env;
  if (tracks === undefined) return;
  if (!Array.isArray(tracks)) {
    err(path, `must be an array of { "param": "...", "keys": [...] }, got ${show(tracks)}`);
    return;
  }
  const seen = new Map<string, number>();
  tracks.forEach((track: unknown, i: number) => {
    const tp = `${path}[${i}]`;
    if (!isObject(track)) {
      err(tp, `must be an object like { "param": "x", "keys": [{ "t": 0, "v": 0 }] }, got ${show(track)}`);
      return;
    }
    checkFields(err, track, tp, TRACK_FIELDS);
    let spec: ParamSpec | undefined;
    const param = track.param;
    if (!isNonEmptyString(param)) {
      err(`${tp}.param`, `must be a non-empty string (a param name), got ${show(param)}`);
    } else {
      if (seen.has(param)) {
        err(`${tp}.param`, `duplicate track for "${param}" (also tracks[${seen.get(param)}]); merge the keys into one track`);
      } else {
        seen.set(param, i);
      }
      if (rig) {
        spec = specOf(rig, param);
        if (!spec) err(`${tp}.param`, unknownParam(rig, param));
      }
    }

    const keys = track.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      err(`${tp}.keys`, `must be a non-empty array of { "t": seconds, "v": value } keys, got ${show(keys)}`);
      return;
    }
    let prevT: number | undefined;
    let prevIndex = -1;
    keys.forEach((key: unknown, k: number) => {
      const kp = `${tp}.keys[${k}]`;
      if (!isObject(key)) {
        err(kp, `must be an object like { "t": 0, "v": 0 }, got ${show(key)}`);
        return;
      }
      checkFields(err, key, kp, KEY_FIELDS);
      const t = key.t;
      if (!(typeof t === 'number' && Number.isFinite(t))) {
        err(`${kp}.t`, `must be a finite number of seconds, got ${show(t)}`);
      } else {
        if (prevT !== undefined && !(t > prevT)) {
          err(`${kp}.t`, `key times must be strictly increasing: ${t} is not after keys[${prevIndex}].t = ${prevT}`);
        }
        prevT = t;
        prevIndex = k;
      }
      if (!isParamValue(key.v)) {
        err(`${kp}.v`, `must be a finite number, string, or boolean, got ${show(key.v)}`);
      } else if (rig && spec && isNonEmptyString(param)) {
        const problem = typeMismatch(spec, key.v, rig, param);
        if (problem) err(`${kp}.v`, problem);
      }
      if (key.ease !== undefined && !(typeof key.ease === 'string' && (EASING_NAMES as readonly string[]).includes(key.ease))) {
        err(`${kp}.ease`, `unknown easing ${show(key.ease)}; use one of ${EASING_NAMES.join(', ')} (or omit for linear)`);
      }
    });
  });
}

function checkOverrides(env: Env, layer: Obj, layerPath: string, layerRig: Rig | undefined): void {
  const { err, frames } = env;
  const overrides = layer.overrides;
  const path = `${layerPath}.overrides`;
  if (overrides === undefined) return;
  if (!Array.isArray(overrides)) {
    err(path, `must be an array of { "from": frame, "to": frame, "rig"?: "...", "params"?: {...} }, got ${show(overrides)}`);
    return;
  }
  const ranges: { i: number; from: number; to: number }[] = [];
  overrides.forEach((o: unknown, i: number) => {
    const op = `${path}[${i}]`;
    if (!isObject(o)) {
      err(op, `must be an object like { "from": 36, "to": 48, "params": {...} }, got ${show(o)}`);
      return;
    }
    checkFields(err, o, op, OVERRIDE_FIELDS);
    const fromOk = typeof o.from === 'number' && Number.isInteger(o.from);
    const toOk = typeof o.to === 'number' && Number.isInteger(o.to);
    if (!fromOk) err(`${op}.from`, `must be an integer output frame, got ${show(o.from)}`);
    if (!toOk) err(`${op}.to`, `must be an integer output frame (exclusive), got ${show(o.to)}`);
    if (fromOk && toOk) {
      const from = o.from as number;
      const to = o.to as number;
      let inRange = true;
      if (from < 0) {
        err(`${op}.from`, `must be >= 0, got ${from}`);
        inRange = false;
      }
      if (frames !== undefined && to > frames) {
        err(`${op}.to`, `must be <= ${frames} (the scene's frame count, fps * duration), got ${to}`);
        inRange = false;
      }
      if (from >= to) {
        err(op, `needs from < to (ranges are [from, to), so to is the first frame after the override), got from ${from}, to ${to}`);
      } else if (inRange) {
        ranges.push({ i, from, to });
      }
    }

    let rig = layerRig;
    if (o.rig !== undefined) {
      if (!isNonEmptyString(o.rig)) {
        err(`${op}.rig`, `must be a non-empty string (a rig id; omit it to keep the layer rig), got ${show(o.rig)}`);
        rig = undefined;
      } else if (env.registry && layerRig && baseRigId(o.rig) !== baseRigId(layerRig.id)) {
        err(`${op}.rig`, baseMismatch(env.registry, o.rig, layerRig.id));
        rig = undefined;
      } else {
        rig = lookupRig(env, o.rig, `${op}.rig`);
        if (rig && layerRig && rig !== layerRig) checkOverrideInputs(env, layer, layerPath, o, op, layerRig, rig);
      }
    }
    checkParams(env, o.params, `${op}.params`, rig);
  });

  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      const x = ranges[a];
      const y = ranges[b];
      if (x.from < y.to && y.from < x.to) {
        err(
          `${path}[${y.i}]`,
          `overlaps overrides[${x.i}] ([${y.from}, ${y.to}) and [${x.from}, ${x.to})); overrides on one layer must not overlap. Ranges are [from, to), so [a, b) and [b, c) may touch`,
        );
      }
    }
  }
}

/** An override may swap in only the layer rig's base or one of the base's variants. */
function baseMismatch(registry: RigRegistry, rigId: string, layerRigId: string): string {
  const base = baseRigId(layerRigId);
  const variants = variantsOf(registry, base).map((r) => JSON.stringify(r.id));
  const hint =
    variants.length > 0
      ? `registered variants of "${base}": ${variants.join(', ')}`
      : `no variants of "${base}" are registered; a variant is a rig with an id like "${base}.name"`;
  return `rig "${rigId}" does not share a base with the layer rig "${layerRigId}"; an override may only swap in "${base}" or one of its variants (${hint})`;
}

/**
 * An override that swaps the rig still passes the layer's params and track
 * values to the new rig. Check every value that reaches it on the override's
 * frames, skipping params the override itself sets and layer params a track
 * replaces. Problems are reported at the override path. Values that already
 * fail on the layer rig are reported where they are written, not again here.
 */
function checkOverrideInputs(env: Env, layer: Obj, layerPath: string, o: Obj, op: string, layerRig: Rig, rig: Rig): void {
  const setByOverride = new Set(isObject(o.params) ? Object.keys(o.params) : []);
  const tracks = Array.isArray(layer.tracks) ? layer.tracks : [];
  const tracked = new Set(tracks.flatMap((t: unknown) => (isObject(t) && isNonEmptyString(t.param) ? [t.param] : [])));
  const span = overrideTimes(env, layer, o);
  const when = span ? `on frames [${o.from}, ${o.to})` : 'inside this override';
  const report = (what: string, problem: string) => env.err(op, `${when} ${what} reaches override rig "${rig.id}": ${problem}`);
  const fitsLayerRig = (name: string, v: unknown) => {
    const spec = specOf(layerRig, name);
    return spec !== undefined && typeMismatch(spec, v, layerRig, name) === undefined;
  };

  if (isObject(layer.params)) {
    for (const [name, v] of Object.entries(layer.params)) {
      if (setByOverride.has(name) || tracked.has(name) || !fitsLayerRig(name, v)) continue;
      const spec = specOf(rig, name);
      const problem = spec ? typeMismatch(spec, v, rig, name) : unknownParam(rig, name);
      if (problem) report(`the layer's param "${name}" (${layerPath}.params.${name})`, problem);
    }
  }

  tracks.forEach((track: unknown, i: number) => {
    if (!isObject(track) || !isNonEmptyString(track.param) || setByOverride.has(track.param)) return;
    const name = track.param;
    if (!specOf(layerRig, name)) return;
    const spec = specOf(rig, name);
    if (!spec) {
      report(`track "${name}" (${layerPath}.tracks[${i}])`, unknownParam(rig, name));
      return;
    }
    if (!Array.isArray(track.keys) || track.keys.length === 0) return;
    const [first, last] = reachableKeys(track.keys, span);
    for (let k = first; k <= last; k++) {
      const key: unknown = track.keys[k];
      if (!isObject(key) || !fitsLayerRig(name, key.v)) continue;
      const problem = typeMismatch(spec, key.v, rig, name);
      if (problem) report(`track "${name}" key ${k} (${layerPath}.tracks[${i}].keys[${k}].v)`, problem);
    }
  });
}

/** The first and last quantized time the layer sees inside a valid override, or undefined. */
function overrideTimes(env: Env, layer: Obj, o: Obj): [number, number] | undefined {
  const { fps, frames } = env;
  const { from, to } = o;
  if (fps === undefined || frames === undefined) return undefined;
  if (!(typeof from === 'number' && typeof to === 'number' && Number.isInteger(from) && Number.isInteger(to))) return undefined;
  if (!(from >= 0 && from < to && to <= frames)) return undefined;
  const step = layer.stepFps;
  if (step !== undefined && !(typeof step === 'number' && Number.isFinite(step) && step > 0 && step <= fps)) return undefined;
  return [quantizeTime(from, fps, step as number | undefined), quantizeTime(to - 1, fps, step as number | undefined)];
}

/**
 * Indices of the keys whose values a track can produce between two times.
 * A track holds key k from its time until the next key, and interpolates
 * only between numbers, so those keys cover every value's type. Falls back
 * to every key when the times or keys are not usable.
 */
function reachableKeys(keys: unknown[], span: [number, number] | undefined): [number, number] {
  const all: [number, number] = [0, keys.length - 1];
  if (!span) return all;
  const times = keys.map((k) => (isObject(k) && typeof k.t === 'number' && Number.isFinite(k.t) ? k.t : Number.NaN));
  if (times.some((t, i) => Number.isNaN(t) || (i > 0 && !(t > times[i - 1])))) return all;
  const holding = (t: number) => {
    let i = 0;
    while (i + 1 < times.length && times[i + 1] <= t) i++;
    return i;
  };
  return [holding(span[0]), holding(span[1])];
}

function checkAudio(env: Env, audio: unknown): void {
  const { err } = env;
  if (!Array.isArray(audio)) {
    err('audio', `must be an array of { "id", "generator", "start", "end" } cues, got ${show(audio)}`);
    return;
  }
  const seen = new Map<string, number>();
  audio.forEach((cue: unknown, i: number) => {
    const p = `audio[${i}]`;
    if (!isObject(cue)) {
      err(p, `must be an object like { "id": "buzz", "generator": "buzz", "start": 0, "end": 1 }, got ${show(cue)}`);
      return;
    }
    checkFields(err, cue, p, AUDIO_FIELDS);
    if (!isNonEmptyString(cue.id)) {
      err(`${p}.id`, `must be a non-empty string, got ${show(cue.id)}`);
    } else if (seen.has(cue.id)) {
      err(`${p}.id`, `duplicate audio id "${cue.id}" (also used by audio[${seen.get(cue.id)}]); audio ids must be unique`);
    } else {
      seen.set(cue.id, i);
    }
    if (!isNonEmptyString(cue.generator)) err(`${p}.generator`, `must be a non-empty string (a generator id), got ${show(cue.generator)}`);
    const startOk = typeof cue.start === 'number' && Number.isFinite(cue.start);
    const endOk = typeof cue.end === 'number' && Number.isFinite(cue.end);
    if (!startOk) err(`${p}.start`, `must be a finite number of seconds, got ${show(cue.start)}`);
    if (!endOk) err(`${p}.end`, `must be a finite number of seconds, got ${show(cue.end)}`);
    if (startOk && endOk && !((cue.start as number) < (cue.end as number))) {
      err(p, `needs start < end, got start ${cue.start}, end ${cue.end}`);
    }
    checkParams(env, cue.params, `${p}.params`, undefined);
  });
}
