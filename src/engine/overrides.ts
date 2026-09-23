import type { Override } from './types';

/** The override covering an output frame, using [from, to). Overlaps are invalid, so at most one matches. */
export function activeOverride(overrides: readonly Override[] | undefined, frame: number): Override | undefined {
  if (!overrides) return undefined;
  for (const o of overrides) {
    if (o.from <= frame && frame < o.to) return o;
  }
  return undefined;
}
