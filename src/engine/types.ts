export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;
export type EasingName = 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'inCubic' | 'outCubic' | 'inOutCubic' | 'inQuart' | 'outQuart' | 'inOutQuart' | 'inSine' | 'outSine' | 'inOutSine' | 'inExpo' | 'outExpo' | 'inOutExpo' | 'inBack' | 'outBack' | 'inOutBack';
export interface Key { t: number; v: ParamValue; ease?: EasingName }      // t in seconds; ease shapes the segment ARRIVING at this key; default linear
export interface Track { param: string; keys: Key[] }
export interface Override { from: number; to: number; rig?: string; params?: Params }   // output frames, [from, to)
export interface LayerSpec { rig: string; params?: Params; stepFps?: number; tracks?: Track[]; overrides?: Override[] }
export interface Layer extends LayerSpec { id: string }
export interface AudioCue { id: string; generator: string; start: number; end: number; params?: Params }
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
