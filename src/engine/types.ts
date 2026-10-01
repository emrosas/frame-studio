export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;
export type EasingName = 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'inCubic' | 'outCubic' | 'inOutCubic' | 'inQuart' | 'outQuart' | 'inOutQuart' | 'inSine' | 'outSine' | 'inOutSine' | 'inExpo' | 'outExpo' | 'inOutExpo' | 'inBack' | 'outBack' | 'inOutBack';
export interface Key { t: number; v: ParamValue; ease?: EasingName }      // t in seconds; ease shapes the segment ARRIVING at this key; default linear
export interface Track { param: string; keys: Key[] }
export interface Override { from: number; to: number; rig?: string; params?: Params }   // output frames, [from, to)
/** A layer's mask (ADR 0007): a rig drawn with the layer's time; the layer shows only where it draws. */
export interface MaskSpec { rig: string; params?: Params; tracks?: Track[] }
/**
 * A layer. A drawing layer names a `rig`, or a `cast` member of its project. A scene layer names a
 * sibling `scene` of its project and places it: `start` in this scene's seconds, and a trim
 * [`in`, `out`) in the shot's own seconds (ADR 0007). Its params are the placement in SCENE_LAYER_PARAMS.
 */
export interface LayerSpec {
  rig?: string;
  cast?: string;
  scene?: string;
  start?: number;
  in?: number;
  out?: number;
  params?: Params;
  stepFps?: number;
  tracks?: Track[];
  overrides?: Override[];
  mask?: MaskSpec;
}
export interface Layer extends LayerSpec { id: string }
/** A named character of a project (ADR 0007): a rig and the params that make it that character. */
export interface CastEntry { rig: string; params?: Params }
export type Cast = Readonly<Record<string, CastEntry>>;
/**
 * A sound cue from `start` to `end` in scene seconds, snapped to frames: a generator's sound, or a sound
 * file from the studio folder's media/ (ADR 0012). Its tracks animate only volume (cue.ts).
 */
export interface AudioCue {
  id: string;
  /** The generator that makes the sound. A cue has this or `file`. */
  generator?: string;
  /** A sound file, e.g. "media/voice.mp3". A cue has this or `generator`. */
  file?: string;
  start: number;
  end: number;
  /** For a file: seconds into it where the cue starts playing. Any sample, so finer than a frame. Default 0. */
  in?: number;
  /** For a file: seconds to fade in from silence at the start, and out to silence before the end. */
  fadeIn?: number;
  fadeOut?: number;
  /** For a generator: its params. */
  params?: Params;
  tracks?: Track[];
}
export interface Scene { id: string; fps: number; duration: number; size: [number, number]; seed: number; background?: LayerSpec; layers: Layer[]; audio?: AudioCue[] }
export const BACKGROUND_ID = 'background';   // the background layer's id; user layers may not use it
export interface Rng { next(): number; range(min: number, max: number): number; int(minInclusive: number, maxExclusive: number): number; pick<T>(items: readonly T[]): T; fork(key: string): Rng }
export type ParamSpec =
  | { type: 'number'; default: number; min?: number; max?: number; description?: string }
  | { type: 'string'; default: string; description?: string }
  | { type: 'color'; default: string; description?: string }
  | { type: 'enum'; default: string; options: readonly string[]; description?: string }
  | { type: 'boolean'; default: boolean; description?: string };
export type ParamSchema = Record<string, ParamSpec>;
export interface Stage { width: number; height: number }   // scene size in scene pixels
/** A context a rig can draw on: the visible canvas, or an offscreen one (hit-test probe, selection mask). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/**
 * Passed to Rig.draw next to stage. A rig that declares parts wraps every
 * mark in part(id, draw), with an id from its parts list. The visible render
 * calls draw() straight through; hit testing and selection masks use the
 * boundaries to tell parts apart or to draw only some of them.
 */
export interface DrawKit {
  part(id: string, draw: () => void): void;
}
export interface Rig {
  id: string;              // variants use "base.variant", e.g. "fly.wingTorn"
  description?: string;
  params: ParamSchema;
  parts?: readonly string[];
  draw(ctx: Ctx2D, params: Params, t: number, rng: Rng, stage: Stage, kit: DrawKit): void;
}
export type RigRegistry = ReadonlyMap<string, Rig>;
/**
 * Offscreen contexts from the host, for compositing: masks, and scene layers drawn with opacity. The
 * engine never makes a canvas itself; the viewer, the render page and the embed each provide these.
 */
export interface Surfaces {
  /** A transparent context with `like`'s pixel size and current transform. */
  create(like: Ctx2D): Ctx2D;
  /** Hands a context from create back, so it can be reused. */
  release(surface: Ctx2D): void;
}
/**
 * What a scene draws with beyond its own file, when it belongs to a project (ADR 0007): the sibling
 * scenes its scene layers place, by bare id, and the project's cast. Surfaces are needed only for
 * masks and scene layers drawn with opacity. A loose scene needs none of it.
 */
export interface World {
  scenes?: ReadonlyMap<string, Scene>;
  cast?: Cast;
  surfaces?: Surfaces;
}
