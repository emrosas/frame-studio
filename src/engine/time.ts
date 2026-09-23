/**
 * Time model. Authoring is in seconds, rendering is in frames.
 * Frames are integers in [0, frameCount). t = frame / fps.
 */

/**
 * Epsilon that absorbs float error in t * fps, which can land just below a
 * whole number (1.16 * 25 = 28.999999999999996) or just above it
 * (8.3 * 30 = 249.00000000000003).
 */
const EPS = 1e-9;

export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}

export function timeToFrame(t: number, fps: number): number {
  return Math.floor(t * fps + EPS);
}

/** Number of output frames. Frames are [0, frameCount). A partial last frame counts. */
export function frameCount(scene: { fps: number; duration: number }): number {
  return Math.ceil(scene.duration * scene.fps - EPS);
}

/**
 * The time a layer sees on an output frame. With stepFps, time is held on a
 * coarser grid ("on twos"). Integer math first so held frames compare equal.
 * EPS covers decimal stepFps, where 360 * 0.7 lands just below 252.
 */
export function quantizeTime(frame: number, fps: number, stepFps?: number): number {
  if (stepFps === undefined) return frame / fps;
  return Math.floor((frame * stepFps) / fps + EPS) / stepFps;
}
