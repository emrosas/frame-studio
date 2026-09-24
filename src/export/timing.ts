// Frame timing and codec choices for exports. Pure, so it is unit tested
// without a browser.

/** Start of `frame` in whole microseconds, the unit WebCodecs uses. */
export function frameTimestampUs(frame: number, fps: number): number {
  return Math.round((frame * 1e6) / fps);
}

/** Duration of `frame` in microseconds: up to the next frame's start, so frames tile the timeline exactly. */
export function frameDurationUs(frame: number, fps: number): number {
  return frameTimestampUs(frame + 1, fps) - frameTimestampUs(frame, fps);
}

/** A key frame on frame 0 and every 2 seconds after, so seeking in a player stays cheap. */
export function isKeyFrame(frame: number, fps: number): boolean {
  return frame % Math.max(1, Math.round(fps * 2)) === 0;
}

/**
 * Per-frame GIF delays in centiseconds, spread so they add up to exactly
 * count / fps seconds (rounded to the nearest centisecond). Browsers show a
 * delay under 2 cs as 10 cs, so frame rates above 50 are refused.
 */
export function gifDelaysCs(count: number, fps: number): number[] {
  if (fps > 50) throw new RangeError(`GIF cannot play faster than 50 fps (a frame needs at least 2 cs); this scene is ${fps} fps`);
  const at = (frame: number) => Math.round((frame * 100) / fps);
  return Array.from({ length: count }, (_, i) => at(i + 1) - at(i));
}

/** H.264 levels from ITU-T H.264 Table A-1: level_idc, max macroblocks per second, max frame size in macroblocks. */
const AVC_LEVELS: readonly [idc: number, maxMbps: number, maxFs: number][] = [
  [0x28, 245_760, 8_192], // 4.0
  [0x2a, 522_240, 8_704], // 4.2
  [0x32, 589_824, 22_080], // 5.0
  [0x33, 983_040, 36_864], // 5.1
  [0x34, 2_073_600, 36_864], // 5.2
];

/**
 * The avc1 codec string for High profile at the lowest level, from 4.0 up,
 * that fits this size and rate. Level 4.0 covers 1080p up to 30 fps, which
 * every encoder ticket 14 tested accepts.
 */
export function avcCodecString(width: number, height: number, fps: number): string {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError(`H.264 with 4:2:0 chroma needs an even width and height; this scene is ${width}x${height}`);
  }
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find(([, maxMbps, maxFs]) => frameMbs <= maxFs && frameMbs * fps <= maxMbps);
  if (!level) throw new RangeError(`${width}x${height} at ${fps} fps is too large for H.264 level 5.2`);
  return `avc1.6400${level[0].toString(16).padStart(2, '0')}`;
}
