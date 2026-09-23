import type { ParamSchema, ParamSpec, Params } from '../../engine/types';
import { clamp } from './math';

/** Schema entry helpers, so a rig's params read as a table. */
export const num = (def: number, min: number, max: number, description: string) =>
  ({ type: 'number', default: def, min, max, description }) as const;
export const col = (def: string, description: string) => ({ type: 'color', default: def, description }) as const;
export const choice = (def: string, options: readonly string[], description: string) =>
  ({ type: 'enum', default: def, options, description }) as const;

/**
 * Typed access to a rig's resolved params.
 *
 * A missing value, or one of the wrong type, falls back to the schema default.
 * Numbers are clamped to the schema's min/max, so eased overshoot (inBack,
 * outBack) can never push a radius negative or an opacity above 1.
 * Reading a key the schema does not declare throws: that is a bug in the rig.
 */
export interface ParamReader {
  number(key: string): number;
  /** A number param rounded to the nearest integer, then clamped. */
  integer(key: string): number;
  /** A string, color, or enum param. Enum values outside `options` fall back to the default. */
  string(key: string): string;
  boolean(key: string): boolean;
}

export function readParams(schema: ParamSchema, params: Params): ParamReader {
  function spec<T extends ParamSpec['type']>(key: string, ...types: T[]): Extract<ParamSpec, { type: T }> {
    const found = schema[key];
    if (!found) throw new Error(`rig reads param "${key}", which its schema does not declare`);
    if (!types.includes(found.type as T)) {
      throw new Error(`rig reads param "${key}" as ${types.join('/')}, but the schema declares it as ${found.type}`);
    }
    return found as Extract<ParamSpec, { type: T }>;
  }

  function number(key: string): number {
    const s = spec(key, 'number');
    const value = params[key];
    const n = typeof value === 'number' && Number.isFinite(value) ? value : s.default;
    return clamp(n, s.min ?? -Infinity, s.max ?? Infinity);
  }

  return {
    number,
    integer(key) {
      const s = spec(key, 'number');
      return clamp(Math.round(number(key)), s.min ?? -Infinity, s.max ?? Infinity);
    },
    string(key) {
      const s = spec(key, 'string', 'color', 'enum');
      const value = params[key];
      if (typeof value !== 'string') return s.default;
      if (s.type === 'enum' && !s.options.includes(value)) return s.default;
      return value;
    },
    boolean(key) {
      const s = spec(key, 'boolean');
      const value = params[key];
      return typeof value === 'boolean' ? value : s.default;
    },
  };
}
