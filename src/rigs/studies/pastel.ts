// PROTOTYPE paint study (pastel): oil pastel on toothy paper. Rigs for scenes/bears-pastel.json.
import type { Rig } from '../../engine/types';
import { pastelBear } from './pastel/bear';
import { pastelGround } from './pastel/ground';

export const pastelRigs: readonly Rig[] = [pastelGround, pastelBear];
