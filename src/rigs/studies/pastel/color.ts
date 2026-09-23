// PROTOTYPE colour mixing for the pastel study.
import { isNone } from './crayon';

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/.exec(color.trim().toLowerCase());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

/** a blended toward b by t (0 = a, 1 = b). Hex in, hex out; anything else goes through CSS color-mix. */
export function mix(a: string, b: string, t: number): string {
  if (isNone(a)) return b;
  if (isNone(b)) return a;
  const k = Math.min(1, Math.max(0, t));
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (ra && rb) return `#${hex2(ra[0] + (rb[0] - ra[0]) * k)}${hex2(ra[1] + (rb[1] - ra[1]) * k)}${hex2(ra[2] + (rb[2] - ra[2]) * k)}`;
  return `color-mix(in srgb, ${a} ${((1 - k) * 100).toFixed(1)}%, ${b})`;
}
