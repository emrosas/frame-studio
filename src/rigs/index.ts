import { createRegistry } from '../engine/registry';
import type { Rig, RigRegistry } from '../engine/types';
import { bear } from './bear';
import { bearArm } from './bear-arm';
import { bearBandaged } from './bear-bandaged';
import { bearBlush } from './bear-blush';
import { circle } from './circle';
import { paper } from './paper';
import { rect } from './rect';
import { star } from './star';
import { studyRigs } from './studies';
import { text } from './type/text';

export { bear, bearArm, bearBandaged, bearBlush, circle, paper, rect, star, text };

/** Every rig the studio ships. Add new rigs (and variants) here. */
export const allRigs: readonly Rig[] = [paper, circle, rect, star, text, bear, bearArm, bearBandaged, bearBlush, ...studyRigs];

export function createDefaultRegistry(): RigRegistry {
  return createRegistry(allRigs);
}
