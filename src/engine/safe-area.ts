// Where a video's own text is safe from a platform's interface. On a vertical
// video that's what TikTok, Reels and Shorts cover (the viewer's guide draws the
// same numbers, in 1080x1920 scene pixels); on any other shape it's a plain
// title-safe margin. Used by the captions rig and the check tool.

export const SAFE_INSET = { top: 260, right: 140, bottom: 480, left: 60 };

/** The share of each side a stage that isn't vertical keeps clear. */
const MARGIN = 0.05;

export interface SafeArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The safe part of a stage, in its own pixels. */
export function safeArea(width: number, height: number): SafeArea {
  if (height > width) {
    const scale = width / 1080;
    const x = SAFE_INSET.left * scale;
    const y = SAFE_INSET.top * scale;
    return { x, y, width: width - x - SAFE_INSET.right * scale, height: height - y - SAFE_INSET.bottom * scale };
  }
  const x = width * MARGIN;
  const y = height * MARGIN;
  return { x, y, width: width - 2 * x, height: height - 2 * y };
}
