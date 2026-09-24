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
export { createRegistry, defaultParams, baseRigId, variantsOf, rigIdsUsed } from './registry';
export { clampFrame, PlaybackClock, playbackFrame, wrapFrame, type LoopRange, type PlaybackAnchor, type Timeline } from './playback';
export { sceneLayers, resolveLayer, type ResolvedLayer } from './resolve';
export { render, drawLayer, assertFrame, resetContextState } from './render';
export { PASS_THROUGH, onlyParts } from './kit';
export { hitTest, type HitCandidate, type HitResult, type HitTestOptions } from './hit-test';
export { validateScene, type ValidationResult } from './validate';
export { applyToSelection, formatSceneJson, mergePatch, type EditSelection, type SelectionPatch } from './scene-edit';
