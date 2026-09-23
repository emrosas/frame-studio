// Pointer geometry for picking on the canvas. Pure: callers pass the canvas
// element's bounding rect (CSS pixels) and the scene size. The backing store
// follows devicePixelRatio, so canvas.width is never the right divisor.

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Scene-to-CSS scale and the letterbox offsets of a scene fitted into a box with "contain", centred. */
function containFit(boxW: number, boxH: number, sceneW: number, sceneH: number): { k: number; ox: number; oy: number } | null {
  if (!(boxW > 0 && boxH > 0 && sceneW > 0 && sceneH > 0)) return null;
  const k = Math.min(boxW / sceneW, boxH / sceneH);
  return { k, ox: (boxW - sceneW * k) / 2, oy: (boxH - sceneH * k) / 2 };
}

/**
 * Maps a pointer position (clientX, clientY, in CSS pixels) to scene pixels.
 * The scene is fitted into the box with "contain", so a box whose aspect
 * differs from the scene has centred bars that are outside the scene. Returns
 * null outside [0, sceneW) x [0, sceneH) or when the box has no size.
 */
export function clientToScene(clientX: number, clientY: number, rect: BoxRect, sceneW: number, sceneH: number): Point | null {
  const fit = containFit(rect.width, rect.height, sceneW, sceneH);
  if (!fit) return null;
  const x = (clientX - rect.left - fit.ox) / fit.k;
  const y = (clientY - rect.top - fit.oy) / fit.k;
  if (!(x >= 0 && x < sceneW && y >= 0 && y < sceneH)) return null;
  return { x, y };
}

/** Scene pixels to CSS pixels relative to the box's top-left corner (the inverse of clientToScene). */
export function sceneToBox(x: number, y: number, boxW: number, boxH: number, sceneW: number, sceneH: number): Point {
  const fit = containFit(boxW, boxH, sceneW, sceneH);
  if (!fit) return { x: 0, y: 0 };
  return { x: fit.ox + x * fit.k, y: fit.oy + y * fit.k };
}

/** True when the pointer travelled more than `tolerance` CSS pixels between two points. */
export function isDrag(a: Point, b: Point, tolerance = 4): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) > tolerance;
}
