// PROTOTYPE gouache study: tiny colour mixing without the DOM.

type Rgb = readonly [number, number, number];

const NAMED: Readonly<Record<string, Rgb>> = { white: [255, 255, 255], black: [0, 0, 0] };

/** Parses hex (3, 4, 6 or 8 digits), rgb()/rgba() with plain numbers, white and black. Anything else is null. */
function parse(color: string): Rgb | null {
  const c = color.trim().toLowerCase();
  if (NAMED[c]) return NAMED[c];
  let m = /^#([\da-f]{3,4})$/.exec(c);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  m = /^#([\da-f]{6})(?:[\da-f]{2})?$/.exec(c);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function hex(v: number): string {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return n.toString(16).padStart(2, '0');
}

/**
 * a blended toward b by t (0 = a, 1 = b). Numeric for colours it can parse,
 * otherwise a CSS color-mix() string so any valid CSS colour still works.
 */
export function mix(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    return `#${hex(pa[0] + (pb[0] - pa[0]) * k)}${hex(pa[1] + (pb[1] - pa[1]) * k)}${hex(pa[2] + (pb[2] - pa[2]) * k)}`;
  }
  return `color-mix(in srgb, ${a} ${Math.round((1 - k) * 100)}%, ${b})`;
}
