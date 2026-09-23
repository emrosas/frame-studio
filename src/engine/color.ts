/**
 * Colour syntax check for 'color' params. A canvas silently ignores a colour
 * it cannot parse and keeps the previous fillStyle, which after
 * resetContextState is black, so a typo would paint black with no error.
 *
 * Pure string checks, no DOM: the validator also runs outside a browser.
 * Accepts "none" (rigs skip the paint), hex with 3, 4, 6 or 8 digits, the CSS
 * named colours plus "transparent", and CSS colour functions by name with
 * balanced parentheses. Function arguments are not checked. Case-insensitive.
 */

const NAMED =
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
  'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
  'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
  'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
  'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
  'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
  'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
  'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
  'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
  'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
  'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
  'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
  'whitesmoke yellow yellowgreen transparent none';

let named: ReadonlySet<string> | undefined;

/** The CSS named colours, plus "transparent" and "none". */
export function namedColors(): ReadonlySet<string> {
  named ??= new Set(NAMED.split(' '));
  return named;
}

const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/;
const FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\((.*)\)$/s;

export function isCssColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (HEX.test(v) || namedColors().has(v)) return true;
  const body = FUNCTION.exec(v)?.[1];
  if (body === undefined) return false;
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
