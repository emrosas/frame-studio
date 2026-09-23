/**
 * A fake 2D context for tests. It records every method call and property
 * write as a string, so two draws can be compared for determinism without a
 * real canvas. Reading ctx.canvas throws: rigs must use the stage argument.
 */
export interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  log: string[];
}

export function createRecordingContext(): RecordingContext {
  const log: string[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const gradient = {
    addColorStop: (offset: number, color: string) => void log.push(`addColorStop(${offset},${color})`),
  };

  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'canvas') throw new Error('rigs must not read ctx.canvas; use the stage argument');
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          log.push(`${prop}(${args.map(format).join(',')})`);
          if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return gradient;
          return undefined;
        };
      },
      set(_target, prop, value: unknown) {
        if (typeof prop === 'symbol') return false;
        state[prop] = value;
        log.push(`${prop}=${format(value)}`);
        return true;
      },
    },
  );

  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

function format(value: unknown): string {
  return typeof value === 'object' && value !== null ? '[object]' : String(value);
}
