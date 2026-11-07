import { createRegistry } from '../engine/registry';
import type { Rig, RigRegistry } from '../engine/types';
import { bear } from './bear';
import { bearArm } from './bear-arm';
import { bearBandaged } from './bear-bandaged';
import { bearBlush } from './bear-blush';
import { circle } from './circle';
import { fill } from './fill';
import { paper } from './paper';
import { rect } from './rect';
import { arrow } from './pixel/arrow';
import { drift } from './pixel/drift';
import { pixelText } from './pixel/pixel-text';
import { ridge } from './pixel/ridge';
import { sky } from './pixel/sky';
import { sprite } from './pixel/sprite';
import { star } from './star';
import { studyRigs } from './studies';
import { captions } from './type/captions';
import { text } from './type/text';

export { arrow, bear, bearArm, bearBandaged, bearBlush, captions, circle, drift, fill, paper, pixelText, rect, ridge, sky, sprite, star, text };

/** Every rig the studio ships. Add new rigs (and variants) here. */
export const allRigs: readonly Rig[] = [paper, fill, circle, rect, star, text, captions, bear, bearArm, bearBandaged, bearBlush, pixelText, sprite, sky, ridge, drift, arrow, ...studyRigs];

export function createDefaultRegistry(): RigRegistry {
  return createRegistry(allRigs);
}
