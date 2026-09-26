// The app (ADR 0008). It opens a studio folder, runs the studio server on it
// in a utility process, shows the viewer the server serves in a window, and
// keeps a hidden render worker window for the server's jobs. IPC carries only
// the token handoff and native features: folder pickers, Reveal in Finder and
// menus. The app's data goes over the server's HTTP and event stream, as in a
// browser. Electron main process only.

import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type MenuItemConstructorOptions, type Rectangle, type UtilityProcess } from 'electron';
import { createStudioFolder, writeTsconfig } from './folders.ts';
import { appPaths } from './paths.ts';
import { adoptShellPath } from './shell-path.ts';
import { openWorkerWindow } from './worker.ts';

interface Settings {
  /** Studio folders, most recent first. */
  recent: string[];
  bounds?: Rectangle;
}

interface Session {
  folder: string;
  url: string;
  token: string;
  server: UtilityProcess;
  worker: BrowserWindow;
  stopping: boolean;
}

const paths = appPaths();
let settings: Settings = { recent: [] };
let session: Session | null = null;
let main: BrowserWindow | null = null;
let welcome: BrowserWindow | null = null;
let serverLog: WriteStream | null = null;
let mainLog: WriteStream | null = null;
let restarts = 0;

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function log(line: string): void {
  mainLog?.write(`${new Date().toISOString()} ${line}\n`);
}

async function loadSettings(): Promise<Settings> {
  try {
    const read = JSON.parse(await readFile(settingsFile(), 'utf8')) as Partial<Settings>;
    return { recent: Array.isArray(read.recent) ? read.recent.filter((p) => typeof p === 'string') : [], ...(read.bounds ? { bounds: read.bounds } : {}) };
  } catch {
    return { recent: [] };
  }
}

async function saveSettings(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`).catch(() => {});
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Our environment, minus the switch that turns an Electron binary into plain Node. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  return env;
}

// ---- the studio server ----

/** Starts the studio server on `folder` and waits until it listens. */
async function startServer(folder: string, token: string): Promise<{ server: UtilityProcess; url: string }> {
  const server = utilityProcess.fork(
    paths.server,
    ['--folder', folder, '--viewer', paths.viewer, '--builtins', paths.builtins, '--agents', '--discovery', '--worker', 'app'],
    { env: childEnv(), stdio: 'pipe', serviceName: 'Frame Studio server' },
  );
  server.stdout?.on('data', (chunk: Buffer) => serverLog?.write(chunk));
  server.stderr?.on('data', (chunk: Buffer) => serverLog?.write(chunk));
  // The token goes by message, never on the command line.
  server.postMessage({ token });
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => {
      server.kill();
      fail(new Error('The studio server did not start within 30 s.'));
    }, 30_000);
    server.once('message', (message: { url?: unknown }) => {
      clearTimeout(timer);
      if (typeof message.url === 'string') done(message.url);
      else fail(new Error('The studio server answered without an address.'));
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`The studio server stopped while starting (exit ${code}). See ${join(app.getPath('logs'), 'server.log')}.`));
    });
  });
  return { server, url };
}

async function stopSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  current.stopping = true;
  if (!current.worker.isDestroyed()) current.worker.destroy();
  current.server.kill();
}

/** Opens run one at a time, so a double click can't start two servers. */
let opening: Promise<string | null> = Promise.resolve(null);

/**
 * Opens `folder`: its server, its render worker, and the viewer. The folder open now stays until the new server
 * is up, so a folder that fails to open leaves you where you were. Returns why it failed, or null.
 */
function openFolder(folder: string, options: { restart?: boolean } = {}): Promise<string | null> {
  const run = opening.then(() => openFolderNow(folder, options));
  opening = run.catch(() => null);
  return run;
}

async function openFolderNow(folder: string, options: { restart?: boolean }): Promise<string | null> {
  const dir = resolve(folder);
  if (!(await isDirectory(dir))) return `${dir} is not a folder.`;
  if (!options.restart) restarts = 0;
  await writeTsconfig(dir, paths.builtins).catch((err: unknown) => log(`tsconfig: ${String(err)}`));
  const token = randomBytes(24).toString('base64url');
  if (options.restart || session?.folder === dir) await stopSession();
  let started: { server: UtilityProcess; url: string };
  try {
    started = await startServer(dir, token);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(why);
    if (options.restart) scheduleRestart(dir);
    return why;
  }
  await stopSession();
  const worker = openWorkerWindow(started.url, token);
  const current: Session = { folder: dir, url: started.url, token, server: started.server, worker, stopping: false };
  session = current;
  started.server.once('exit', (code) => {
    if (current.stopping || session !== current) return;
    log(`studio server exited (${code})`);
    scheduleRestart(dir, current);
  });
  settings.recent = [dir, ...settings.recent.filter((p) => p !== dir)].slice(0, 10);
  void saveSettings();
  buildMenu();
  showViewer(started.url, basename(dir));
  welcome?.close();
  return null;
}

/** Restarts the server on `dir` after it died, with a growing pause, unless the user has moved on; gives up after five. */
function scheduleRestart(dir: string, died?: Session): void {
  if (++restarts > 5) {
    dialog.showErrorBox('Frame Studio', `The studio server keeps stopping. See ${join(app.getPath('logs'), 'server.log')}.`);
    return;
  }
  setTimeout(() => {
    // Only if nothing else opened meanwhile.
    if (died ? session === died : session === null) void openFolder(dir, { restart: true });
  }, 500 * restarts);
}

/** Runs a folder action from a menu, and shows why it failed. */
function report(action: Promise<string | null>): void {
  void action.then((problem) => {
    if (problem) dialog.showErrorBox('Frame Studio', problem);
  });
}

// ---- windows ----

function guard(win: BrowserWindow): void {
  // The page stays on the studio server; links elsewhere open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (session && new URL(url).origin === new URL(session.url).origin) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showViewer(url: string, name: string): void {
  if (!main || main.isDestroyed()) {
    const bounds = settings.bounds;
    main = new BrowserWindow({
      width: bounds?.width ?? 1400,
      height: bounds?.height ?? 900,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 800,
      minHeight: 500,
      title: 'Frame Studio',
      backgroundColor: '#111213',
      webPreferences: { preload: join(paths.desktop, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    guard(main);
    let crashes = 0;
    main.webContents.on('render-process-gone', () => {
      if (++crashes <= 3) main?.webContents.reload();
    });
    main.on('close', () => {
      if (main) settings.bounds = main.getBounds();
      void saveSettings();
    });
    main.on('closed', () => {
      main = null;
      // The hidden render worker is a window too, so closing the viewer must end the app itself.
      app.quit();
    });
  }
  main.setTitle(`${name} · Frame Studio`);
  void main.loadURL(`${url}/`);
  main.show();
}

function showWelcome(): void {
  if (welcome && !welcome.isDestroyed()) {
    welcome.focus();
    return;
  }
  welcome = new BrowserWindow({
    width: 560,
    height: 460,
    resizable: false,
    title: 'Frame Studio',
    backgroundColor: '#111213',
    webPreferences: { preload: join(paths.desktop, 'welcome-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  guard(welcome);
  void welcome.loadFile(join(paths.desktop, 'welcome.html'));
  welcome.on('closed', () => {
    welcome = null;
  });
}

// ---- folders ----

async function pickFolder(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? main ?? welcome;
  const options = { title: 'Open Studio Folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return openFolder(picked.filePaths[0]);
}

/** Makes ~/Frame Studio with the samples, or the next free "~/Frame Studio N", and opens it. */
async function newFolder(): Promise<string | null> {
  // Tests put new folders elsewhere; HOME itself must stay real, since the login shell reads its profile there.
  const home = process.env.FRAME_STUDIO_HOME ?? homedir();
  let dir = join(home, 'Frame Studio');
  for (let n = 2; await isDirectory(dir); n++) {
    const names = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    if (names.every((name) => name.startsWith('.'))) break;
    dir = join(home, `Frame Studio ${n}`);
  }
  try {
    await createStudioFolder(dir, paths.samples);
  } catch (err) {
    return `Could not make ${dir}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return openFolder(dir);
}

// ---- menus ----

function buildMenu(): void {
  const recent: MenuItemConstructorOptions[] = settings.recent.length
    ? settings.recent.map((path) => ({ label: path, click: () => report(openFolder(path)) }))
    : [{ label: 'No recent folders', enabled: false }];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Studio Folder', accelerator: 'CmdOrCtrl+Shift+N', click: () => report(newFolder()) },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => report(pickFolder()) },
        { label: 'Open Recent', submenu: recent },
        { type: 'separator' },
        {
          label: 'Reveal Output Folder',
          enabled: session !== null,
          click: async () => {
            if (!session) return;
            const out = join(session.folder, 'out');
            await mkdir(out, { recursive: true });
            void shell.openPath(out);
          },
        },
        { label: 'Reveal Studio Folder', enabled: session !== null, click: () => session && void shell.openPath(session.folder) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Show Logs', click: () => void shell.openPath(app.getPath('logs')) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: the token handoff and native features only ----

function fromViewer(frameUrl: string | undefined): boolean {
  return session !== null && frameUrl !== undefined && frameUrl.startsWith(`${session.url}/`);
}

function registerIpc(): void {
  ipcMain.on('frame-studio:token', (event) => {
    event.returnValue = fromViewer(event.senderFrame?.url) ? session!.token : '';
  });
  ipcMain.on('frame-studio:recent', (event) => {
    event.returnValue = settings.recent;
  });
  ipcMain.handle('frame-studio:reveal', (event, path: string) => {
    if (!session || !fromViewer(event.senderFrame?.url)) return;
    const target = resolve(path);
    // Only files in the studio folder.
    if (relative(session.folder, target).startsWith('..')) return;
    shell.showItemInFolder(target);
  });
  ipcMain.handle('frame-studio:open-folder', () => pickFolder());
  ipcMain.handle('frame-studio:new-folder', () => newFolder());
  ipcMain.handle('frame-studio:open-recent', (_event, path: string) => openFolder(path));
}

export function runApp(): void {
  // Named and placed before the single-instance lock, which keys on them. Run from the repo, Electron would
  // otherwise call itself "Electron". Tests keep their settings apart from yours.
  app.setName('Frame Studio');
  const userData = process.env.FRAME_STUDIO_USER_DATA ?? join(app.getPath('appData'), 'Frame Studio');
  app.setPath('userData', userData);
  app.setAppLogsPath(process.env.FRAME_STUDIO_USER_DATA ? join(userData, 'logs') : join(homedir(), 'Library/Logs/Frame Studio'));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Finder hands the app launchd's PATH; agents need the user's.
  adoptShellPath();
  app.on('second-instance', () => {
    const win = main ?? welcome;
    if (!win) {
      if (session) showViewer(session.url, basename(session.folder));
      else showWelcome();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  // The Dock icon with no window up: the viewer if a folder is open, else the welcome screen.
  app.on('activate', () => {
    if (main || welcome) return;
    if (session) showViewer(session.url, basename(session.folder));
    else showWelcome();
  });
  app.on('before-quit', () => void stopSession());
  registerIpc();
  void app.whenReady().then(async () => {
    const logs = app.getPath('logs');
    await mkdir(logs, { recursive: true });
    mainLog = createWriteStream(join(logs, 'main.log'), { flags: 'a' });
    serverLog = createWriteStream(join(logs, 'server.log'), { flags: 'a' });
    settings = await loadSettings();
    buildMenu();
    const last = settings.recent[0];
    if (last && (await isDirectory(last)) && !(await openFolder(last))) return;
    showWelcome();
  });
}
