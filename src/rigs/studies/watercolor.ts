/** PROTOTYPE paint study (watercolor). Rigs for scenes/bears-watercolor.json. */
import type { Rig } from '../../engine/types';
import { watercolorBear } from './watercolor/bear';
import { watercolorGround } from './watercolor/ground';

export const watercolorRigs: readonly Rig[] = [watercolorGround, watercolorBear];
