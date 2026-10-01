// The app (ADR 0008, ADR 0013). It opens projects, each a folder: a studio
// server on each in a utility process, with a hidden render worker window for
// its jobs. One project is on screen at a time, in the viewer its server
// serves; a project you switch away from keeps running while an agent works
// there, and stops when none does. IPC carries only the token handoff and
// native features: the project switcher's list, folder pickers, Reveal in
// Finder, menus and updates. The app's data goes over each server's HTTP and
// event stream, as in a browser. Electron main process only.

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync, type WriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle, type UtilityProcess } from 'electron';
import { createStudioFolder, writeTsconfig } from './folders.ts';
import { createProject, hasAgentWork, listProjects } from './projects.ts';
import { appPaths } from './paths.ts';
import { adoptShellPath } from './shell-path.ts';
import { checkForUpdates, checkFromMenu, installUpdate, openReleaseNotes, startUpdates, type UpdateState, updatesEnabled, updateState } from './updater.ts';
import { openWorkerWindow } from './worker.ts';

interface Settings {
  /** Project folders, most recent first. */
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
/** Every project whose server runs, by folder. */
const sessions = new Map<string, Session>();
/** The project on screen. */
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

/** Writes the settings whole, through a temporary file, so quitting mid-write never leaves half a file. */
async function saveSettings(): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    const partial = `${settingsFile()}.partial`;
    await writeFile(partial, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(partial, settingsFile());
  } catch {
    // Settings are a convenience; the app works without them.
  }
}

/** The same, at once, for quitting, when nothing async gets to finish. */
function saveSettingsNow(): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const partial = `${settingsFile()}.partial`;
    writeFileSync(partial, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(partial, settingsFile());
  } catch {
    // as above
  }
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

/** Stops a project's server and render worker. */
function stopSession(target: Session | null): void {
  if (!target) return;
  if (session === target) session = null;
  sessions.delete(target.folder);
  target.stopping = true;
  if (!target.worker.isDestroyed()) target.worker.destroy();
  target.server.kill();
}

/** Stops the projects in the background whose agents have nothing left to do (ADR 0013). */
async function sweep(): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (s === session || s.stopping) continue;
    if (!(await hasAgentWork(s.folder))) {
      log(`stopping ${s.folder}: nothing runs there`);
      stopSession(s);
    }
  }
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
  let target = sessions.get(dir);
  if (target && options.restart) {
    stopSession(target);
    target = undefined;
  }
  // A project still running in the background comes back as it is, its agents mid-turn.
  if (!target) {
    await writeTsconfig(dir, paths.builtins).catch((err: unknown) => log(`tsconfig: ${String(err)}`));
    const token = randomBytes(24).toString('base64url');
    let started: { server: UtilityProcess; url: string };
    try {
      started = await startServer(dir, token);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log(why);
      if (options.restart) scheduleRestart(dir);
      return why;
    }
    const worker = openWorkerWindow(started.url, token);
    const opened: Session = { folder: dir, url: started.url, token, server: started.server, worker, stopping: false };
    target = opened;
    sessions.set(dir, opened);
    started.server.once('exit', (code) => {
      if (opened.stopping) return;
      log(`studio server for ${dir} exited (${code})`);
      if (session === opened) scheduleRestart(dir, opened);
      else stopSession(opened);
    });
  }
  const previous = session;
  session = target;
  settings.recent = [dir, ...settings.recent.filter((p) => p !== dir)].slice(0, 10);
  void saveSettings();
  buildMenu();
  showViewer(target.url, basename(dir));
  welcome?.close();
  // The project left behind keeps running only while its agents work.
  if (previous && previous !== target) void sweep();
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

/** The page's background under the system's theme, and on macOS no title bar: the pages draw their own, with room for the window buttons. */
function windowLook(): Electron.BrowserWindowConstructorOptions {
  return {
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#fbfaf9',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
  };
}

function showViewer(url: string, name: string): void {
  if (!main || main.isDestroyed()) {
    const bounds = settings.bounds;
    main = new BrowserWindow({
      width: bounds?.width ?? 1400,
      height: bounds?.height ?? 900,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 960,
      minHeight: 560,
      title: 'Frame Studio',
      ...windowLook(),
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
    width: 720,
    height: 480,
    resizable: false,
    title: 'Frame Studio',
    ...windowLook(),
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
  const options = { title: 'Open Project', buttonLabel: 'Open', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return openFolder(picked.filePaths[0]);
}

/** Where new projects go by default: ~/Frame Studio Projects. Tests put it elsewhere; HOME stays real for the login shell. */
function projectsHome(): string {
  return join(process.env.FRAME_STUDIO_HOME ?? homedir(), 'Frame Studio Projects');
}

/** Asks for a new project's name and place in the save panel, makes the folder, and opens it (ADR 0013). */
async function newProject(): Promise<string | null> {
  await mkdir(projectsHome(), { recursive: true }).catch(() => {});
  const parent = BrowserWindow.getFocusedWindow() ?? main ?? welcome;
  const options: Electron.SaveDialogOptions = {
    title: 'New Project',
    buttonLabel: 'Create',
    nameFieldLabel: 'Project:',
    defaultPath: join(projectsHome(), 'Untitled Project'),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return null;
  const problem = await createProject(picked.filePath).catch((err: unknown) => `Could not make ${picked.filePath}: ${err instanceof Error ? err.message : String(err)}`);
  return problem ?? openFolder(picked.filePath);
}

/** Makes the sample project in ~/Frame Studio Projects/Sample, the first time, and opens it. */
async function sampleProject(): Promise<string | null> {
  const dir = join(projectsHome(), 'Sample');
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
    : [{ label: 'No recent projects', enabled: false }];
  // Electron's own app menu, with Check for Updates… after About.
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      ...(updatesEnabled() ? [{ label: 'Check for Updates…', click: () => void checkFromMenu() }] : []),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [appMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => report(newProject()) },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => report(pickFolder()) },
        { label: 'Open Recent', submenu: recent },
        { label: 'Open Sample Project', click: () => report(sampleProject()) },
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
        { label: 'Reveal Project Folder', enabled: session !== null, click: () => session && void shell.openPath(session.folder) },
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

/** The viewer, or the welcome page: the app's own pages. */
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  if (fromViewer(url)) return true;
  return welcome !== null && event.sender === welcome.webContents && url === pathToFileURL(join(paths.desktop, 'welcome.html')).href;
}

/** Sends an update state to the app's pages. */
function pushUpdate(state: UpdateState): void {
  for (const win of [main, welcome]) if (win && !win.isDestroyed()) win.webContents.send('frame-studio:update-changed', state);
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
  ipcMain.handle('frame-studio:open-folder', (event) => (fromApp(event) ? pickFolder() : null));
  ipcMain.handle('frame-studio:new-project', (event) => (fromApp(event) ? newProject() : null));
  ipcMain.handle('frame-studio:sample-project', (event) => (fromApp(event) ? sampleProject() : null));
  ipcMain.handle('frame-studio:open-recent', (event, path: string) => (fromApp(event) && settings.recent.includes(path) ? openFolder(path) : null));
  // The project switcher's list (ADR 0013): the recent projects with their threads that need a look.
  ipcMain.handle('frame-studio:projects', (event) => (fromApp(event) ? listProjects(settings.recent, session?.folder ?? null, new Set(sessions.keys())) : []));
  // Updates (ADR 0009). The preloads offer them only when the app can update.
  ipcMain.on('frame-studio:updates', (event) => {
    event.returnValue = updatesEnabled() && fromApp(event);
  });
  ipcMain.handle('frame-studio:update-state', (event) => (updatesEnabled() && fromApp(event) ? updateState() : undefined));
  ipcMain.handle('frame-studio:update-check', (event) => (updatesEnabled() && fromApp(event) ? checkForUpdates(true) : undefined));
  ipcMain.handle('frame-studio:update-install', (event) => (updatesEnabled() && fromApp(event) ? installUpdate() : undefined));
  ipcMain.handle('frame-studio:update-notes', (event) => (updatesEnabled() && fromApp(event) ? openReleaseNotes() : undefined));
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
  app.on('before-quit', () => {
    if (main && !main.isDestroyed()) settings.bounds = main.getBounds();
    saveSettingsNow();
    for (const s of [...sessions.values()]) stopSession(s);
  });
  registerIpc();
  void app.whenReady().then(async () => {
    if (paths.dockIcon && existsSync(paths.dockIcon)) app.dock?.setIcon(paths.dockIcon);
    const logs = app.getPath('logs');
    await mkdir(logs, { recursive: true });
    mainLog = createWriteStream(join(logs, 'main.log'), { flags: 'a' });
    serverLog = createWriteStream(join(logs, 'server.log'), { flags: 'a' });
    settings = await loadSettings();
    buildMenu();
    if (updatesEnabled()) startUpdates({ push: pushUpdate, log });
    setInterval(() => void sweep(), 5000);
    const last = settings.recent[0];
    if (last && (await isDirectory(last)) && !(await openFolder(last))) return;
    showWelcome();
  });
}
