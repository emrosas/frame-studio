import { createRegistry } from '../engine/registry';
import type { Rig, RigRegistry } from '../engine/types';
import { bear } from './bear';
import { bearBandaged } from './bear-bandaged';
import { circle } from './circle';
import { paper } from './paper';
import { rect } from './rect';
import { star } from './star';
import { studyRigs } from './studies';

export { bear, bearBandaged, circle, paper, rect, star };

/** Every rig the studio ships. Add new rigs (and variants) here. */
export const allRigs: readonly Rig[] = [paper, circle, rect, star, bear, bearBandaged, ...studyRigs];

export function createDefaultRegistry(): RigRegistry {
  return createRegistry(allRigs);
}
