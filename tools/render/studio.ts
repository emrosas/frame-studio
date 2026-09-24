// Opens the render page (render.html) in Playwright's headless Chromium, with
// a Vite server behind it, and routes the page's bytes into files. Shared by
// the CLI and the browser tests. Node only; runs as TypeScript through Node's
// type stripping, so relative imports carry their .ts extension.

import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { RenderSceneInfo, RenderStudioApi } from '../../src/viewer/render-api.ts';
import { ROOT } from '../scene-files.ts';

export { ROOT };

/**
 * Ticket 03: keep 2D canvas raster on the CPU and Skia's runtime-chosen code
 * paths off, so pixels repeat run to run. Playwright's headless shell already
 * forces an sRGB colour profile.
 */
export const CHROMIUM_ARGS = ['--disable-accelerated-2d-canvas', '--disable-skia-runtime-opts'];

type Methods = {
  [K in keyof RenderStudioApi as RenderStudioApi[K] extends (...args: never[]) => unknown ? K : never]: RenderStudioApi[K];
};

export interface Studio {
  readonly page: Page;
  readonly browser: Browser;
  /** The scene the page opened. */
  readonly scene: RenderSceneInfo;
  /** Calls window.studio[name](...args) in the page and returns the result. */
  call<K extends keyof Methods>(name: K, ...args: Parameters<Methods[K]>): Promise<Awaited<ReturnType<Methods[K]>>>;
  /** A sink id whose bytes land in `path`. Parent folders are created. */
  fileSink(path: string): Promise<string>;
  /** Closes a sink's file if the page has not already. Safe to call twice. */
  closeSink(sinkId: string): Promise<void>;
  /** Opens another scene in the same browser and server. */
  load(sceneKey: string): Promise<RenderSceneInfo>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Called as export stages progress in the page. */
  onProgress?(stage: string, done: number, total: number): void;
  /** Reuse a browser instead of launching one (the caller closes it). */
  browser?: Browser;
  /** Reuse a listening Vite server from startVite instead of starting one (the caller closes it). */
  server?: ViteDevServer;
}

/**
 * Starts Vite for render.html on a free port. With watch, file edits
 * invalidate Vite's module cache, so a reloaded page sees them; the render
 * CLI runs once and leaves it off.
 */
export async function startVite(options: { watch?: boolean } = {}): Promise<ViteDevServer> {
  // Port 0: the OS picks a free port as Vite binds it, so parallel runs cannot collide.
  const server = await createServer({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, ...(options.watch ? {} : { watch: null }) },
  });
  try {
    await server.listen();
  } catch (err) {
    await server.close();
    throw err;
  }
  return server;
}

/** Strips Playwright's "page.evaluate: " wrapper so messages read as the page wrote them. */
function pageError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(message.replace(/^page\.evaluate: (Error: )?/, '').replace(/\n\s+at .*$/s, ''));
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: CHROMIUM_ARGS });
}

export async function openStudio(sceneKey: string, options: OpenOptions = {}): Promise<Studio> {
  const ownsServer = !options.server;
  const server = options.server ?? (await startVite());
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const ownsBrowser = !options.browser;
  try {
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite started without a local URL.');
    browser = options.browser ?? (await launchBrowser());
    context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const pageLog: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') pageLog.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => pageLog.push(`[pageerror] ${e.message}`));

    const sinks = new Map<string, FileHandle>();
    let nextSink = 0;
    await page.exposeFunction('__studioWrite', async (sinkId: string, base64: string, position: number) => {
      const handle = sinks.get(sinkId);
      if (!handle) throw new Error(`unknown sink ${sinkId}`);
      const data = Buffer.from(base64, 'base64');
      await handle.write(data, 0, data.length, position);
    });
    await page.exposeFunction('__studioClose', async (sinkId: string) => {
      await sinks.get(sinkId)?.close();
      sinks.delete(sinkId);
    });
    await page.exposeFunction('__studioProgress', (stage: string, done: number, total: number) => options.onProgress?.(stage, done, total));

    const load = async (key: string): Promise<RenderSceneInfo> => {
      await page.goto(`${base}render.html?scene=${encodeURIComponent(key)}`);
      try {
        await page.waitForFunction(() => (window as unknown as { studio?: RenderStudioApi }).studio?.ready === true, undefined, { timeout: 30_000 });
      } catch {
        throw new Error(`The render page did not start.\n${pageLog.join('\n') || '(no console output)'}`);
      }
      const state = await page.evaluate(() => {
        const s = (window as unknown as { studio: RenderStudioApi }).studio;
        return { scene: s.scene, errors: [...s.errors] };
      });
      if (!state.scene || state.errors.length > 0) throw new Error(`Scene "${key}" cannot render:\n${state.errors.join('\n')}`);
      return state.scene;
    };

    let scene = await load(sceneKey);
    const openContext = context;
    return {
      page,
      browser,
      get scene() {
        return scene;
      },
      async call(name, ...args) {
        try {
          return await page.evaluate(
            ({ name, args }) => (window as unknown as { studio: Record<string, (...a: unknown[]) => unknown> }).studio[name](...args),
            { name: name as string, args: args as unknown[] },
          ) as never;
        } catch (err) {
          throw pageError(err);
        }
      },
      async fileSink(path) {
        await mkdir(dirname(path), { recursive: true });
        const id = `sink-${nextSink++}`;
        sinks.set(id, await open(path, 'w'));
        return id;
      },
      async closeSink(sinkId) {
        await sinks.get(sinkId)?.close().catch(() => {});
        sinks.delete(sinkId);
      },
      async load(key) {
        scene = await load(key);
        return scene;
      },
      async close() {
        for (const handle of sinks.values()) await handle.close().catch(() => {});
        await openContext.close().catch(() => {});
        if (ownsBrowser) await browser?.close().catch(() => {});
        if (ownsServer) await server.close();
      },
    };
  } catch (err) {
    await context?.close().catch(() => {});
    if (ownsBrowser) await browser?.close().catch(() => {});
    if (ownsServer) await server.close();
    throw err;
  }
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
