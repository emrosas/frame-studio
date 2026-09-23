// PROTOTYPE paint study (gouache). Rigs for scenes/bears-gouache.json.
import type { Rig } from '../../engine/types';
import { gouacheBear } from './gouache/bear';
import { gouacheGround } from './gouache/ground';

export const gouacheRigs: readonly Rig[] = [gouacheGround, gouacheBear];
