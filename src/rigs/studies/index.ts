import type { Rig } from '../../engine/types';
import { gouacheRigs } from './gouache';
import { pastelRigs } from './pastel';
import { watercolorRigs } from './watercolor';

/** PROTOTYPE paint studies (ticket 13). Throwaway once the look is settled. */
export const studyRigs: readonly Rig[] = [...gouacheRigs, ...watercolorRigs, ...pastelRigs];
