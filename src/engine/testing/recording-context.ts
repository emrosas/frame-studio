/**
 * A fake CanvasRenderingContext2D for tests. It is a Proxy that logs every
 * method call (with args) and every property set, and it simulates the parts
 * of canvas state that decide what a draw call paints: style properties, the
 * transform, the line dash, the clip stack, and the current path. Paint calls
 * (fill, stroke, fillRect, fillText, drawImage, ...) carry a snapshot of that
 * state in the log, so two logs are equal only if the pixels would be too.
 *
 * Test-only. Not exported from src/engine/index.ts, and it must stay free of
 * third-party imports because it lives under src/engine.
 */

/** 2D affine matrix [a, b, c, d, e, f], as in ctx.setTransform(a, b, c, d, e, f). */
export type Matrix = [number, number, number, number, number, number];

export interface PathSegment {
  name: string;
  args: unknown[];
  transform: Matrix;
}

export interface ClipRecord {
  path: PathSegment[];
  args: unknown[];
  transform: Matrix;
}

export interface DrawState {
  props: Record<string, unknown>;
  transform: Matrix;
  lineDash: number[];
  clips: ClipRecord[];
}

export type LogEntry =
  | { op: 'call'; name: string; args: unknown[]; paint?: PaintSnapshot }
  | { op: 'set'; name: string; value: unknown };

/** State that affected a paint call. `path` is present when the call used the current path. */
export interface PaintSnapshot {
  props?: Record<string, unknown>;
  transform: Matrix;
  lineDash?: number[];
  clips: ClipRecord[];
  path?: PathSegment[];
}

export interface RecordingContext {
  /** The fake context. Pass it anywhere a CanvasRenderingContext2D is expected. */
  readonly ctx: CanvasRenderingContext2D;
  /** Everything that happened since creation or the last clearLog(). */
  readonly log: LogEntry[];
  clearLog(): void;
  /** Snapshot of the current state (deep copy). */
  state(): DrawState;
  /** How many save() calls are waiting for a restore(). */
  saveDepth(): number;
}

/** Initial values from the HTML canvas spec. */
export const DEFAULT_PROPS: Readonly<Record<string, unknown>> = Object.freeze({
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  lineDashOffset: 0,
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  filter: 'none',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  direction: 'inherit',
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
  letterSpacing: '0px',
  wordSpacing: '0px',
  fontKerning: 'auto',
  fontStretch: 'normal',
  fontVariantCaps: 'normal',
  textRendering: 'auto',
});

const PATH_METHODS = new Set([
  'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'arc', 'ellipse', 'rect', 'roundRect', 'closePath',
]);

/** Paint calls affected by the full drawing state. */
const STYLED_PAINT = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage']);
/** Paint calls that use the current path unless given a Path2D. */
const USES_PATH = new Set(['fill', 'stroke', 'clip', 'isPointInPath', 'isPointInStroke']);

const OTHER_METHODS = new Set([
  'save', 'restore', 'reset', 'beginPath', 'clip', 'clearRect', 'putImageData',
  'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'getTransform',
  'createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern',
  'isPointInPath', 'isPointInStroke', 'measureText', 'createImageData', 'getImageData',
  'setLineDash', 'getLineDash', 'drawFocusIfNeeded', 'getContextAttributes', 'isContextLost',
]);

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

function allFinite(args: unknown[]): boolean {
  return args.every((a) => typeof a === 'number' && Number.isFinite(a));
}

function copyState(s: DrawState): DrawState {
  return {
    props: { ...s.props },
    transform: [...s.transform] as Matrix,
    lineDash: [...s.lineDash],
    clips: s.clips.map((c) => ({ path: c.path.map(copySegment), args: [...c.args], transform: [...c.transform] as Matrix })),
  };
}

function copySegment(p: PathSegment): PathSegment {
  return { name: p.name, args: [...p.args], transform: [...p.transform] as Matrix };
}

/** A gradient or pattern as a plain, comparable value (what gets logged and stored when assigned to a style). */
interface StyleDescription {
  kind: string;
  args: unknown[];
  stops?: [number, string][];
}

const DESCRIBE = Symbol('describe');

function makeGradient(kind: string, args: unknown[], log: LogEntry[]): object {
  const stops: [number, string][] = [];
  return {
    addColorStop(offset: number, color: string) {
      log.push({ op: 'call', name: `${kind}.addColorStop`, args: [offset, color] });
      stops.push([offset, color]);
    },
    [DESCRIBE]: (): StyleDescription => ({ kind, args: [...args], stops: stops.map((s) => [s[0], s[1]]) }),
  };
}

function describeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && DESCRIBE in value) {
    return (value as { [DESCRIBE]: () => StyleDescription })[DESCRIBE]();
  }
  return value;
}

function fontSizePx(font: unknown): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? Number(m[1]) : 10;
}

export function createRecordingContext(width = 100, height = 100): RecordingContext {
  const log: LogEntry[] = [];
  let state: DrawState = { props: { ...DEFAULT_PROPS }, transform: [...IDENTITY], lineDash: [], clips: [] };
  const stack: DrawState[] = [];
  let path: PathSegment[] = [];
  const canvas = { width, height };

  function paintSnapshot(name: string, args: unknown[]): PaintSnapshot | undefined {
    const usesPath = USES_PATH.has(name) && !(args.length > 0 && typeof args[0] === 'object' && args[0] !== null);
    if (STYLED_PAINT.has(name)) {
      const snap: PaintSnapshot = {
        props: { ...state.props },
        transform: [...state.transform] as Matrix,
        lineDash: [...state.lineDash],
        clips: copyState(state).clips,
      };
      if (usesPath) snap.path = path.map(copySegment);
      return snap;
    }
    if (name === 'clearRect') {
      return { transform: [...state.transform] as Matrix, clips: copyState(state).clips };
    }
    return undefined;
  }

  function call(name: string, args: unknown[]): unknown {
    const paint = paintSnapshot(name, args);
    log.push(paint ? { op: 'call', name, args, paint } : { op: 'call', name, args });

    if (PATH_METHODS.has(name)) {
      path.push({ name, args, transform: [...state.transform] as Matrix });
      return undefined;
    }
    switch (name) {
      case 'save':
        stack.push(copyState(state));
        return undefined;
      case 'restore':
        if (stack.length > 0) state = stack.pop() as DrawState;
        return undefined;
      case 'reset':
        stack.length = 0;
        state = { props: { ...DEFAULT_PROPS }, transform: [...IDENTITY], lineDash: [], clips: [] };
        path = [];
        return undefined;
      case 'beginPath':
        path = [];
        return undefined;
      case 'clip': {
        const clipPath = args.length > 0 && typeof args[0] === 'object' ? [] : path.map(copySegment);
        state.clips.push({ path: clipPath, args: [...args], transform: [...state.transform] as Matrix });
        return undefined;
      }
      case 'translate':
        if (allFinite(args)) state.transform = multiply(state.transform, [1, 0, 0, 1, args[0] as number, args[1] as number]);
        return undefined;
      case 'scale':
        if (allFinite(args)) state.transform = multiply(state.transform, [args[0] as number, 0, 0, args[1] as number, 0, 0]);
        return undefined;
      case 'rotate': {
        if (!allFinite(args)) return undefined;
        const r = args[0] as number;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        state.transform = multiply(state.transform, [cos, sin, -sin, cos, 0, 0]);
        return undefined;
      }
      case 'transform':
        if (allFinite(args)) state.transform = multiply(state.transform, args.slice(0, 6) as Matrix);
        return undefined;
      case 'setTransform': {
        if (args.length === 0) {
          state.transform = [...IDENTITY];
        } else if (typeof args[0] === 'object' && args[0] !== null) {
          const m = args[0] as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };
          state.transform = [m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0];
        } else if (allFinite(args)) {
          state.transform = args.slice(0, 6) as Matrix;
        }
        return undefined;
      }
      case 'resetTransform':
        state.transform = [...IDENTITY];
        return undefined;
      case 'getTransform': {
        const [a, b, c, d, e, f] = state.transform;
        return { a, b, c, d, e, f, is2D: true };
      }
      case 'setLineDash': {
        const dash = args[0];
        if (Array.isArray(dash) && dash.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
          state.lineDash = dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
        }
        return undefined;
      }
      case 'getLineDash':
        return [...state.lineDash];
      case 'createLinearGradient':
        return makeGradient('linearGradient', args, log);
      case 'createRadialGradient':
        return makeGradient('radialGradient', args, log);
      case 'createConicGradient':
        return makeGradient('conicGradient', args, log);
      case 'createPattern':
        return { [DESCRIBE]: (): StyleDescription => ({ kind: 'pattern', args: [...args] }) };
      case 'measureText': {
        const text = String(args[0] ?? '');
        const size = fontSizePx(state.props.font);
        return {
          width: text.length * size * 0.5,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text.length * size * 0.5,
          actualBoundingBoxAscent: size * 0.8,
          actualBoundingBoxDescent: size * 0.2,
          fontBoundingBoxAscent: size * 0.8,
          fontBoundingBoxDescent: size * 0.2,
        };
      }
      case 'createImageData':
      case 'getImageData': {
        const w = Math.abs(Number(name === 'getImageData' ? args[2] : args[0])) || 1;
        const h = Math.abs(Number(name === 'getImageData' ? args[3] : args[1])) || 1;
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' };
      }
      case 'isPointInPath':
      case 'isPointInStroke':
      case 'isContextLost':
        return false;
      case 'getContextAttributes':
        return { alpha: true, desynchronized: false, colorSpace: 'srgb', willReadFrequently: false };
      default:
        return undefined;
    }
  }

  const methodCache = new Map<string, (...args: unknown[]) => unknown>();
  function method(name: string): (...args: unknown[]) => unknown {
    let fn = methodCache.get(name);
    if (!fn) {
      fn = (...args: unknown[]) => call(name, args);
      methodCache.set(name, fn);
    }
    return fn;
  }

  const isMethod = (name: string) => PATH_METHODS.has(name) || STYLED_PAINT.has(name) || OTHER_METHODS.has(name);

  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'canvas') return canvas;
      if (isMethod(prop)) return method(prop);
      if (prop in state.props) return state.props[prop];
      return undefined;
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      const described = describeValue(value);
      log.push({ op: 'set', name: prop, value: described });
      state.props[prop] = described;
      return true;
    },
    has(_target, prop) {
      return typeof prop === 'string' && (prop === 'canvas' || isMethod(prop) || prop in state.props);
    },
  });

  return {
    ctx: proxy as unknown as CanvasRenderingContext2D,
    log,
    clearLog() {
      log.length = 0;
    },
    state() {
      return copyState(state);
    },
    saveDepth() {
      return stack.length;
    },
  };
}

/**
 * Split a render log into per-layer chunks: the entries between each
 * save() at depth 1 (inside render's outer save) and its matching restore().
 */
export function splitLayerLogs(log: readonly LogEntry[]): LogEntry[][] {
  const chunks: LogEntry[][] = [];
  let depth = 0;
  let current: LogEntry[] | undefined;
  for (const entry of log) {
    if (entry.op === 'call' && entry.name === 'save') {
      depth++;
      if (depth === 2) {
        current = [];
        continue;
      }
    } else if (entry.op === 'call' && entry.name === 'restore') {
      if (depth === 2 && current) {
        chunks.push(current);
        current = undefined;
        depth--;
        continue;
      }
      depth = Math.max(0, depth - 1);
    }
    if (current) current.push(entry);
  }
  return chunks;
}
