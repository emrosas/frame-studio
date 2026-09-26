// Worker-only mode: one hidden window on the studio server's render page, for
// a server running without the app. It reads the server's address and token
// from stdin, reopens the page if it crashes, and quits when the process that
// started it goes away. Electron main process only.

import { app, BrowserWindow } from 'electron';

/** Web preferences for a render worker window: sandboxed, and never throttled while hidden. */
export const WORKER_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
} as const;

async function readConnection(): Promise<{ url: string; token: string }> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += (chunk as Buffer).toString();
    if (text.includes('\n')) break;
  }
  const parsed = JSON.parse(text.trim()) as { url?: unknown; token?: unknown };
  if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') throw new Error('The worker needs { url, token } on stdin.');
  return { url: parsed.url, token: parsed.token };
}

/** Opens a hidden render worker on `url`, pairing with `token`, and keeps it open. */
export function openWorkerWindow(url: string, token: string): BrowserWindow {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: WORKER_PREFERENCES });
  let crashes = 0;
  const page = `${url}/render.html`;
  const load = () => {
    if (!win.isDestroyed()) void win.loadURL(`${page}?worker#token=${encodeURIComponent(token)}`).catch(() => {});
  };
  // Rig code runs in this page: it stays on the render page, opens nothing, and gets no permissions.
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(`${page}?`)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A rig stuck in a loop hangs the page: start it again, and the server sends the job again or gives up on it.
  win.webContents.on('unresponsive', () => {
    if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer();
  });
  // What Chromium says about its GPU features, for the render page to report (ticket 03 wants 2D canvas on the CPU).
  win.webContents.on('dom-ready', () => {
    void win.webContents.executeJavaScript(`window.frameStudioGpu = ${JSON.stringify(app.getGPUFeatureStatus())};`).catch(() => {});
  });
  win.webContents.on('render-process-gone', () => {
    // Reopen, but not in a tight loop.
    if (++crashes <= 5) setTimeout(load, 500 * crashes);
  });
  load();
  return win;
}

export function runWorker(): void {
  app.dock?.hide();
  // No window of ours is ever shown, so closing the last one doesn't mean quit.
  app.on('window-all-closed', () => {});
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      app.quit();
    }
  }, 2000).unref();
  void Promise.all([readConnection(), app.whenReady()])
    .then(([{ url, token }]) => openWorkerWindow(url, token))
    .catch((err: unknown) => {
      console.error(`frame-studio worker: ${err instanceof Error ? err.message : String(err)}`);
      app.exit(1);
    });
}
