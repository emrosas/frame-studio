/**
 * Timecode "MM:SS:FF". FF is the frame within the second (0..fps-1).
 * Minutes are at least two digits and grow as needed. FF is at least two
 * digits, wider when fps - 1 needs more. parseTimecode(formatTimecode(f)) === f.
 */

function assertFps(fps: number): void {
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new RangeError(`fps must be a positive integer, got ${fps}`);
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function frameWidth(fps: number): number {
  return Math.max(2, String(fps - 1).length);
}

export function formatTimecode(frame: number, fps: number): string {
  assertFps(fps);
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`frame must be a non-negative integer, got ${frame}`);
  }
  const totalSeconds = Math.floor(frame / fps);
  const ff = frame - totalSeconds * fps;
  const ss = totalSeconds % 60;
  const mm = (totalSeconds - ss) / 60;
  return `${pad(mm, 2)}:${pad(ss, 2)}:${pad(ff, frameWidth(fps))}`;
}

const TIMECODE_RE = /^(-?\d+):(-?\d+):(-?\d+)$/;

export function parseTimecode(tc: string, fps: number): number {
  assertFps(fps);
  if (typeof tc !== 'string') {
    throw new Error(`timecode must be a string like "00:03:11", got ${typeof tc}`);
  }
  const text = tc.trim();
  const m = TIMECODE_RE.exec(text);
  if (!m) {
    throw new Error(`malformed timecode ${JSON.stringify(tc)}: expected "MM:SS:FF", e.g. "00:03:11"`);
  }
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  const ff = Number(m[3]);
  if (m[1].startsWith('-') || m[2].startsWith('-') || m[3].startsWith('-')) {
    throw new Error(`timecode ${JSON.stringify(tc)} has a negative field; all fields must be >= 0`);
  }
  if (ss >= 60) {
    throw new Error(`timecode ${JSON.stringify(tc)}: seconds must be 0..59, got ${ss}`);
  }
  if (ff >= fps) {
    throw new Error(`timecode ${JSON.stringify(tc)}: frame must be 0..${fps - 1} at ${fps} fps, got ${ff}`);
  }
  return (mm * 60 + ss) * fps + ff;
}
