// Worker-only mode: a hidden window on the studio server's render page, for
// a server running without the app. It reads the server's address and token
// from stdin, reopens the page if it crashes, and quits when the process that
// started it goes away. Later lines on stdin ask for helper windows on more
// slots, for parallel exports (ADR 0019); each window is its own renderer
// process, so they draw at once. Electron main process only.

import { createInterface } from 'node:readline';
import { app, BrowserWindow, powerSaveBlocker } from 'electron';

/** Web preferences for a render worker window: sandboxed, and never throttled while hidden. */
export const WORKER_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,
} as const;

/** Lines of JSON on stdin: first { url, token }, then { helpers: n } whenever the server wants a different number of helpers. */
function readLines(onLine: (message: Record<string, unknown>) => void): void {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    try {
      onLine(JSON.parse(line) as Record<string, unknown>);
    } catch (err) {
      console.error(`frame-studio worker: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** Keeps helper windows on slots 1 to `count` open and closes the rest. */
export function setHelperWindows(helpers: Map<number, BrowserWindow>, count: number, url: string, token: string): void {
  for (const [slot, win] of helpers) {
    if (slot > count || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy();
      helpers.delete(slot);
    }
  }
  for (let slot = 1; slot <= count; slot++) if (!helpers.has(slot)) helpers.set(slot, openWorkerWindow(url, token, slot));
}

/** Opens a hidden render worker on `url`, pairing with `token`, and keeps it open. Slot 0 is the main worker; 1 and up are helpers. */
export function openWorkerWindow(url: string, token: string, slot = 0): BrowserWindow {
  // Each helper gets a session of its own, in memory. Chromium allows six connections to a host per session, and every
  // worker page holds one open for its jobs, so in one shared session six workers would leave none for their writes (ADR 0019).
  const webPreferences = slot > 0 ? { ...WORKER_PREFERENCES, partition: `frame-studio-worker-${slot}` } : WORKER_PREFERENCES;
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences });
  let crashes = 0;
  const page = `${url}/render.html`;
  const load = () => {
    if (!win.isDestroyed()) void win.loadURL(`${page}?worker${slot > 0 ? `=${slot}` : ''}#token=${encodeURIComponent(token)}`).catch(() => {});
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
  // A process with no visible window is a candidate for App Nap, which slows its timers and lowers its priority.
  // Renders and exports here run for whoever asked, so keep it awake (the display may still sleep).
  void app.whenReady().then(() => powerSaveBlocker.start('prevent-app-suspension'));
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
  let connection: { url: string; token: string } | null = null;
  let wanted = 0;
  const helpers = new Map<number, BrowserWindow>();
  const ready = app.whenReady();
  readLines((message) => {
    void ready.then(() => {
      if (!connection) {
        if (typeof message.url !== 'string' || typeof message.token !== 'string') {
          console.error('frame-studio worker: the worker needs { url, token } on stdin.');
          app.exit(1);
          return;
        }
        connection = { url: message.url, token: message.token };
        openWorkerWindow(connection.url, connection.token);
      }
      if (typeof message.helpers === 'number' && Number.isInteger(message.helpers)) wanted = Math.max(0, Math.min(16, message.helpers));
      setHelperWindows(helpers, wanted, connection.url, connection.token);
    });
  });
}
