// The playback clock lives in the engine (src/engine/playback.ts), shared with
// the single-file embed.

export { clampFrame, PlaybackClock, playbackFrame, wrapFrame, type PlaybackAnchor, type Timeline } from '../engine/playback';
