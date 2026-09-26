// A render client for the Node tools (ADR 0008): calls the render worker's
// methods for a scene through a studio server, and routes the bytes it makes
// into files. Inside the server it talks to the render pool directly; the CLI
// talks to a server over HTTP, its own or one the app runs.
// Node only; runs as TypeScript through Node's type stripping, so relative
// imports carry their .ts extension.

import { rename, rm } from 'node:fs/promises';
import type { RenderSceneInfo, RenderStudioApi } from '../../src/viewer/render-api.ts';
import { ROOT } from '../scene-files.ts';
import type { RenderPool, RenderProgress } from '../studio/render-pool.ts';

export { ROOT };

/** How a client reaches a render worker. */
export interface RenderTransport {
  call(scene: string, method: string, args: unknown[], onProgress?: (p: RenderProgress) => void): Promise<unknown>;
  openSink(path: string): Promise<string>;
  closeSink(sinkId: string): Promise<void>;
}

/** The render pool of a server in this process. */
export function poolTransport(pool: RenderPool): RenderTransport {
  return {
    call: (scene, method, args, onProgress) => pool.call(scene, method, args, { onProgress }),
    openSink: (path) => pool.openSink(path),
    closeSink: (sinkId) => pool.closeSink(sinkId),
  };
}

/** A studio server over HTTP, with its pairing token. */
export function httpTransport(url: string, token: string): RenderTransport {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${url}/__studio${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The studio server answered ${res.status}.`);
    return res;
  };
  return {
    async call(scene, method, args, onProgress) {
      const res = await post('/render/call', { scene, method, args });
      // Progress lines, then one answer.
      let text = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += Buffer.from(chunk).toString();
        let nl: number;
        while ((nl = text.indexOf('\n')) >= 0) {
          const raw = text.slice(0, nl).trim();
          text = text.slice(nl + 1);
          // Blank lines keep a long wait alive.
          if (!raw) continue;
          const line = JSON.parse(raw) as { progress?: RenderProgress; ok?: boolean; value?: unknown; error?: string };
          if (line.progress) onProgress?.(line.progress);
          else if (line.ok) return line.value;
          else throw new Error(line.error ?? 'The render failed.');
        }
      }
      throw new Error('The studio server closed the render call without an answer.');
    },
    async openSink(path) {
      return ((await (await post('/render/sinks', { path })).json()) as { sink: string }).sink;
    },
    async closeSink(sinkId) {
      await post(`/render/sinks/${encodeURIComponent(sinkId)}/close`, {});
    },
  };
}

type Methods = {
  [K in keyof RenderStudioApi as RenderStudioApi[K] extends (...args: never[]) => unknown ? K : never]: RenderStudioApi[K];
};

export interface Studio {
  /** The scene the client is on. */
  readonly scene: RenderSceneInfo;
  /** Calls window.studio[name](...args) in the worker, for this scene, and returns the result. */
  call<K extends keyof Methods>(name: K, ...args: Parameters<Methods[K]>): Promise<Awaited<ReturnType<Methods[K]>>>;
  /** A sink id whose bytes land in `path`. Parent folders are created. */
  fileSink(path: string): Promise<string>;
  /** Closes a sink's file if the worker has not already. Safe to call twice. */
  closeSink(sinkId: string): Promise<void>;
  /** Moves to another scene. */
  load(sceneKey: string): Promise<RenderSceneInfo>;
  close(): Promise<void>;
}

export interface OpenOptions {
  transport: RenderTransport;
  /** Called as export stages progress in the worker. */
  onProgress?(stage: string, done: number, total: number): void;
}

/** A client on `sceneKey`. Throws when the scene can't render, with the reasons. */
export async function openStudio(sceneKey: string, options: OpenOptions): Promise<Studio> {
  const { transport } = options;
  const progress = (p: RenderProgress) => options.onProgress?.(p.stage, p.done, p.total);
  const load = async (key: string): Promise<RenderSceneInfo> => {
    const info = (await transport.call(key, 'info', [])) as { scene: RenderSceneInfo | null; errors: string[] };
    if (!info.scene || info.errors.length > 0) throw new Error(`Scene "${key}" cannot render:\n${info.errors.join('\n')}`);
    return info.scene;
  };
  let key = sceneKey;
  let scene = await load(key);
  return {
    get scene() {
      return scene;
    },
    async call(name, ...args) {
      return (await transport.call(key, name as string, args as unknown[], progress)) as never;
    },
    fileSink: (path) => transport.openSink(path),
    closeSink: (sinkId) => transport.closeSink(sinkId).catch(() => {}),
    async load(next) {
      scene = await load(next);
      key = next;
      return scene;
    },
    async close() {},
  };
}

/**
 * Writes through a sink into `path`.partial and renames it to `path` only once
 * `produce` succeeds, so a failed export never leaves a file that looks whole.
 */
export async function writeViaSink<T>(studio: Studio, path: string, produce: (sinkId: string) => Promise<T>): Promise<T> {
  const partial = `${path}.partial`;
  const sink = await studio.fileSink(partial);
  try {
    const result = await produce(sink);
    await studio.closeSink(sink);
    await rename(partial, path);
    return result;
  } finally {
    await studio.closeSink(sink);
    await rm(partial, { force: true });
  }
}
