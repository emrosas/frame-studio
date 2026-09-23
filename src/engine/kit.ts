import type { DrawKit } from './types';

/** The kit the visible render uses: every part draws. */
export const PASS_THROUGH: DrawKit = {
  part(_id, draw) {
    draw();
  },
};

/**
 * Draws only the named parts. Marks outside any part still draw, which is why
 * rigs that declare parts keep every mark inside one.
 */
export function onlyParts(ids: readonly string[]): DrawKit {
  const keep = new Set(ids);
  return {
    part(id, draw) {
      if (keep.has(id)) draw();
    },
  };
}
