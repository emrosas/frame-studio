/**
 * Frame Studio engine. Pure TypeScript, no third-party imports, no DOM
 * beyond the 2D context passed in.
 * The image at frame N is a pure function of (scene, frame, registry).
 */
export * from './types';
export { frameToTime, timeToFrame, frameCount, quantizeTime } from './time';
export { formatTimecode, parseTimecode } from './timecode';
export { EASING_NAMES, easings, ease } from './easing';
export { createRng } from './rng';
export { evaluateTrack, evaluateTracks } from './tracks';
export { activeOverride } from './overrides';
export { createRegistry, defaultParams, baseRigId, variantsOf, rigIdsUsed, isRig } from './registry';
export { clampFrame, PlaybackClock, playbackFrame, playbackPosition, wrapFrame, type LoopRange, type PlaybackAnchor, type Timeline } from './playback';
export { sceneLayers, resolveLayer, type ResolvedLayer } from './resolve';
export { render, drawLayer, assertFrame, resetContextState } from './render';
export { PASS_THROUGH, onlyParts } from './kit';
export { hitTest, type HitCandidate, type HitResult, type HitTestOptions } from './hit-test';
export { isMediaPath, validateScene, type ProjectContext, type SchemaOwner, type ValidationResult } from './validate';
export { sceneGraphErrors, validateProject, type ProjectFile, type ProjectValidation } from './project';
export { CUE_PARAMS, cueVolume } from './cue';
export {
  isIdentityPlacement,
  MAX_SCENE_DEPTH,
  SCENE_LAYER_PARAMS,
  sceneLayerSpan,
  scenePlacement,
  shotFrame,
  type SceneLayerPlacement,
  type SceneLayerSpan,
} from './scene-layer';
export { applyToSelection, formatSceneJson, mergePatch, type EditSelection, type SelectionPatch } from './scene-edit';
