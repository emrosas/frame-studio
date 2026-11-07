// The app (ADR 0008, ADR 0013). It opens projects, each a folder: a studio
// server on each in a utility process, with a hidden render worker window for
// its jobs. One project is on screen at a time, in the viewer its server
// serves; a project you switch away from keeps running while an agent works
// there or for a few minutes after, and then stops. IPC carries only the token
// handoff and native features: the sidebar's project list, what the viewer
// keeps between projects, folder pickers, Reveal in Finder, menus and updates.
// The app's data goes over each server's HTTP and event stream, as in a
// browser. Electron main process only.

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync, type WriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle, type UtilityProcess } from 'electron';
import { convertFilm } from '../tools/studio/convert.ts';
import { createStudioFolder, writeTsconfig } from './folders.ts';
import { createProject, hasAgentWork, listProjects, projectPoster, WARM_MS, warmProjects, type ProjectEntry } from './projects.ts';
import { appPaths } from './paths.ts';
import { adoptShellPath } from './shell-path.ts';
import { checkForUpdates, checkFromMenu, installUpdate, openReleaseNotes, startUpdates, type UpdateState, updatesEnabled, updateState } from './updater.ts';
import { projectCode } from '../tools/studio/project-code.ts';
import { registerVoice } from './voice.ts';
import { openWorkerWindow } from './worker.ts';

interface Settings {
  /** Project folders, most recent first. */
  recent: string[];
  bounds?: Rectangle;
  /** What the viewer keeps between visits. Every project's server has its own port and so its own localStorage, so these live here. */
  prefs?: Record<string, string>;
  /** Projects whose code the user trusts, by real path, with the hash of that code (ADR 0017). */
  trust?: Record<string, { hash: string; added: string }>;
}

interface Session {
  folder: string;
  url: string;
  token: string;
  server: UtilityProcess;
  worker: BrowserWindow;
  stopping: boolean;
  /** Its own rigs and generators load (ADR 0017). */
  trusted: boolean;
  /** When it left the screen. */
  left?: number;
}

/** Where the viewer opens a project: on a scene, on a thread of that scene, or with the New dialog up. */
interface OpenTarget {
  scene?: string;
  thread?: number;
  new?: 'video' | 'scene';
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
/** The sidebar's last list, handed to the next page at once so its rows don't arrive late. */
let listing: ProjectEntry[] = [];
/** Unsent prompts by project, so they outlive a switch. */
const drafts = new Map<string, Record<string, string>>();
/** Projects opened without their code since launch, with the hash the user saw, so a restart doesn't ask again. */
const declined = new Map<string, string>();

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function log(line: string): void {
  mainLog?.write(`${new Date().toISOString()} ${line}\n`);
}

async function loadSettings(): Promise<Settings> {
  try {
    const read = JSON.parse(await readFile(settingsFile(), 'utf8')) as Partial<Settings>;
    return {
      recent: Array.isArray(read.recent) ? read.recent.filter((p) => typeof p === 'string') : [],
      ...(read.bounds ? { bounds: read.bounds } : {}),
      ...(read.prefs && typeof read.prefs === 'object' ? { prefs: read.prefs } : {}),
      ...(read.trust && typeof read.trust === 'object' ? { trust: read.trust } : {}),
    };
  } catch {
    return { recent: [] };
  }
}

let saving: Promise<void> = Promise.resolve();

/** Writes the settings whole, through a temporary file, so quitting mid-write never leaves half a file. One write at a time. */
function saveSettings(): Promise<void> {
  saving = saving.then(async () => {
    try {
      await mkdir(app.getPath('userData'), { recursive: true });
      const partial = `${settingsFile()}.partial`;
      await writeFile(partial, `${JSON.stringify(settings, null, 2)}\n`);
      await rename(partial, settingsFile());
    } catch {
      // Settings are a convenience; the app works without them.
    }
  });
  return saving;
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
async function startServer(folder: string, token: string, trust: Trust, codeChanged: () => void): Promise<{ server: UtilityProcess; url: string }> {
  const server = utilityProcess.fork(
    paths.server,
    ['--folder', folder, '--viewer', paths.viewer, '--builtins', paths.builtins, '--agents', '--discovery', '--worker', 'app', ...(trust.trusted ? ['--code-hash', trust.hash] : ['--untrusted'])],
    { env: childEnv(), stdio: 'pipe', serviceName: 'Frame Studio server' },
  );
  server.on('message', (message: { codeChanged?: unknown }) => {
    if (message.codeChanged === true) codeChanged();
  });
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
  keepTrust(target);
  void saveSettings();
  if (session === target) session = null;
  sessions.delete(target.folder);
  target.stopping = true;
  if (!target.worker.isDestroyed()) target.worker.destroy();
  target.server.kill();
}

/** Stops the projects in the background whose agents have nothing left to do, once they've cooled (ADR 0013). */
async function sweep(): Promise<void> {
  const background = [...sessions.values()].filter((s) => s !== session && !s.stopping);
  const warm = warmProjects(new Map(background.map((s) => [s.folder, s.left ?? 0])), Date.now(), warmMs());
  for (const s of background) {
    if (warm.has(s.folder) || (await hasAgentWork(s.folder))) continue;
    // It may have come back on screen while that looked.
    if (s === session || s.stopping) continue;
    log(`stopping ${s.folder}: nothing runs there`);
    stopSession(s);
  }
}

/** How long a project left behind stays warm. Tests set it. */
function warmMs(): number {
  const set = Number(process.env.FRAME_STUDIO_WARM_MS);
  return process.env.FRAME_STUDIO_WARM_MS !== undefined && Number.isFinite(set) ? set : WARM_MS;
}

// ---- trusting a project's code (ADR 0017) ----

/** Remembers `dir`'s code as trusted, as it is now. */
function trustNow(real: string, hash: string): void {
  settings.trust = { ...settings.trust, [real]: { hash, added: new Date().toISOString().slice(0, 10) } };
  declined.delete(real);
  void saveSettings();
}

/**
 * What an open, trusted project's agents and hands changed is trusted too, or every rig an agent writes would ask
 * again on the next open. Only changes made while it's closed ask.
 */
function keepTrust(target: Session): void {
  if (!target.trusted) return;
  try {
    const code = projectCode(target.folder);
    const real = realpathSync(target.folder);
    if (code.files > 0) settings.trust = { ...settings.trust, [real]: { hash: code.hash, added: settings.trust?.[real]?.added ?? new Date().toISOString().slice(0, 10) } };
  } catch {
    // The folder went away; nothing to remember.
  }
}

/** Asks about `dir`'s code. The native dialog is one no project code can draw or answer. */
async function askTrust(dir: string, files: number): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? main ?? welcome;
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: 'This project contains code.',
    detail: `${basename(dir)} has ${files === 1 ? '1 source file' : `${files} source files`} in its rigs or audio folders. Frame Studio runs that code to draw the project, and it can do what any program on this computer can.\n\nTrust it if you made it or know who did. Without its code the project opens with the built-in rigs only.`,
    buttons: ['Trust', 'Open Without Its Code'],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** Whether `dir`'s code may load, and the code that answer is about. The server holds it to that hash. */
interface Trust {
  trusted: boolean;
  hash: string;
}

/** None to load, trusted as it stands, or the user says so now. */
async function decideTrust(dir: string): Promise<Trust> {
  const real = await realpath(dir);
  const code = projectCode(real);
  const { hash } = code;
  if (code.files === 0 || settings.trust?.[real]?.hash === hash) return { trusted: true, hash };
  if (declined.get(real) === hash) return { trusted: false, hash };
  if (await askTrust(dir, code.files)) {
    trustNow(real, hash);
    return { trusted: true, hash };
  }
  declined.set(real, hash);
  return { trusted: false, hash };
}

/**
 * The server found the code isn't what the user approved: it changed between asking and loading (ADR 0017). The
 * server has refused it. Reopening asks about the code as it is now. It no longer counts as trusted, so closing
 * this session can't bless the change.
 */
function codeChanged(target: Session): void {
  log(`the code in ${target.folder} changed after it was approved`);
  target.trusted = false;
  if (sessions.get(target.folder) === target) report(openFolder(target.folder, { restart: true }));
}

/** Opens run one at a time, so a double click can't start two servers. */
let opening: Promise<string | null> = Promise.resolve(null);

/**
 * Opens `folder`: its server, its render worker, and the viewer. The folder open now stays until the new server
 * is up, so a folder that fails to open leaves you where you were. Returns why it failed, or null.
 */
function openFolder(folder: string, options: { restart?: boolean; target?: OpenTarget } = {}): Promise<string | null> {
  const run = opening.then(() => openFolderNow(folder, options));
  opening = run.catch(() => null);
  return run;
}

async function openFolderNow(folder: string, options: { restart?: boolean; target?: OpenTarget }): Promise<string | null> {
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
    const trust = await decideTrust(dir);
    const token = randomBytes(24).toString('base64url');
    let started: { server: UtilityProcess; url: string };
    let opened: Session | null = null;
    let changed = false;
    try {
      started = await startServer(dir, token, trust, () => {
        changed = true;
        if (opened) codeChanged(opened);
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log(why);
      if (options.restart) scheduleRestart(dir);
      return why;
    }
    const worker = openWorkerWindow(started.url, token);
    const here: Session = { folder: dir, url: started.url, token, server: started.server, worker, stopping: false, trusted: trust.trusted };
    opened = here;
    target = here;
    sessions.set(dir, here);
    started.server.once('exit', (code) => {
      if (here.stopping) return;
      log(`studio server for ${dir} exited (${code})`);
      if (session === here) scheduleRestart(dir, here);
      else stopSession(here);
    });
    if (changed) codeChanged(here);
  }
  const previous = session;
  session = target;
  target.left = undefined;
  settings.recent = [dir, ...settings.recent.filter((p) => p !== dir)].slice(0, 10);
  void saveSettings();
  buildMenu();
  showViewer(target.url, basename(dir), options.target);
  welcome?.close();
  // The project left behind stays warm for a while, and keeps running while its agents work.
  if (previous && previous !== target) {
    previous.left = Date.now();
    void sweep();
  }
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

/** The viewer's background (--bg) in the system's theme, so a switch between projects never shows anything else. */
const pageColour = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7');

/** The page's background under the system's theme, and on macOS no title bar: the pages draw their own, with room for the window buttons. */
function windowLook(): Electron.BrowserWindowConstructorOptions {
  return {
    backgroundColor: pageColour(),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
  };
}

function showViewer(url: string, name: string, target?: OpenTarget): void {
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
  const query = new URLSearchParams({ ...(target?.scene ? { scene: target.scene } : {}), ...(target?.thread !== undefined ? { thread: String(target.thread) } : {}), ...(target?.new ? { new: target.new } : {}) }).toString();
  void main.loadURL(`${url}/${query ? `?${query}` : ''}`);
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

/**
 * Converts film `id` of a listed project, or of the one on screen, projects/<id>/ (M9), into a project
 * folder of its own (ADR 0013): asks where, writes it, and switches to it.
 */
async function convertFilmToProject(id: string, project: string | null): Promise<string | null> {
  const folder = project ?? session?.folder;
  if (!folder) return 'No project is open.';
  const source = join(folder, 'projects', id);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id) || !(await isDirectory(source))) return `There is no film "${id}" in projects/.`;
  await mkdir(projectsHome(), { recursive: true }).catch(() => {});
  const parent = BrowserWindow.getFocusedWindow() ?? main;
  const options: Electron.SaveDialogOptions = {
    title: 'Convert to a Project',
    buttonLabel: 'Convert',
    nameFieldLabel: 'Project:',
    defaultPath: join(projectsHome(), id),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return null;
  const problem = await convertFilm(source, picked.filePath, folder).then(
    () => null,
    (err: unknown) => `Could not convert into ${picked.filePath}: ${err instanceof Error ? err.message : String(err)}`,
  );
  return problem ?? openFolder(picked.filePath);
}

/** Makes the sample project in ~/Frame Studio Projects/Sample, the first time, and opens it. */
async function sampleProject(): Promise<string | null> {
  const dir = join(projectsHome(), 'Sample');
  try {
    const made = await createStudioFolder(dir, paths.samples);
    // We just wrote its code ourselves. One opened again later is held to its hash like any project.
    if (made) {
      const code = projectCode(dir);
      if (code.files > 0) trustNow(await realpath(dir), code.hash);
    }
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
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: session !== null, click: () => main?.webContents.send('frame-studio:open-settings') },
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

/** The project on screen, if `event` came from the main frame of the viewer window: not a frame inside it, and not the render worker. */
function viewerProject(event: IpcMainEvent | IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame;
  const top = main && !main.isDestroyed() ? main.webContents.mainFrame : null;
  if (!session || !top || !frame || event.sender !== main!.webContents) return null;
  if (frame.processId !== top.processId || frame.routingId !== top.routingId) return null;
  return fromViewer(frame.url) ? session.folder : null;
}

/** The longest value the viewer may keep. */
const PREF_MAX = 64 * 1024;

function registerIpc(): void {
  ipcMain.on('frame-studio:token', (event) => {
    event.returnValue = fromViewer(event.senderFrame?.url) ? session!.token : '';
  });
  ipcMain.on('frame-studio:recent', (event) => {
    event.returnValue = settings.recent;
  });
  // What a new page starts from, at once: no flicker of defaults while it asks.
  ipcMain.on('frame-studio:boot', (event) => {
    const here = fromViewer(event.senderFrame?.url) ? session : null;
    event.returnValue = {
      prefs: here ? (settings.prefs ?? {}) : {},
      drafts: here ? (drafts.get(here.folder) ?? {}) : {},
      projects: here ? listing.map((p) => ({ ...p, current: p.path === here.folder })) : [],
    };
  });
  ipcMain.on('frame-studio:pref', (event, key: unknown, value: unknown) => {
    if (!fromViewer(event.senderFrame?.url) || typeof key !== 'string' || !key.startsWith('frame-studio:') || typeof value !== 'string' || value.length > PREF_MAX) return;
    settings.prefs = { ...settings.prefs, [key]: value };
    void saveSettings();
  });
  ipcMain.on('frame-studio:draft', (event, key: unknown, text: unknown) => {
    if (!session || !fromViewer(event.senderFrame?.url) || typeof key !== 'string' || typeof text !== 'string') return;
    const { [key]: _, ...others } = drafts.get(session.folder) ?? {};
    drafts.set(session.folder, text === '' ? others : { ...others, [key]: text });
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
  ipcMain.handle('frame-studio:convert-film', (event, id: string, project: string | null) => {
    if (!fromApp(event) || (project !== null && !settings.recent.includes(project))) return null;
    return convertFilmToProject(String(id), project);
  });
  ipcMain.handle('frame-studio:open-recent', (event, path: string, target?: OpenTarget) => {
    if (!fromApp(event)) return null;
    if (!settings.recent.includes(path)) return `${path} is no longer a recent project.`;
    const scene = typeof target?.scene === 'string' ? target.scene : undefined;
    const thread = Number.isInteger(target?.thread) ? target?.thread : undefined;
    const add = target?.new === 'video' || target?.new === 'scene' ? target.new : undefined;
    return openFolder(path, { target: { ...(scene ? { scene } : {}), ...(thread !== undefined ? { thread } : {}), ...(add ? { new: add } : {}) } });
  });
  ipcMain.handle('frame-studio:forget-recent', (event, path: string) => {
    if (!fromApp(event)) return;
    settings.recent = settings.recent.filter((p) => p !== path);
    void saveSettings();
    buildMenu();
  });
  // The sidebar's list (ADR 0013): each recent project with what it holds and its threads that need a look.
  ipcMain.handle('frame-studio:projects', async (event) => {
    if (!fromApp(event)) return [];
    listing = await listProjects(settings.recent, session?.folder ?? null, new Set(sessions.keys()));
    return listing;
  });
  ipcMain.handle('frame-studio:poster', (event, path: string, file: string) => (fromApp(event) && settings.recent.includes(path) ? projectPoster(path, String(file)) : null));
  registerVoice({ projectOf: viewerProject, window: () => main, pages: paths.desktop, log });
  // Folder trust (ADR 0017). The page can ask for the prompt and take trust away; only the native prompt grants it.
  ipcMain.handle('frame-studio:trust-state', async (event) => {
    const folder = viewerProject(event);
    if (!folder) return null;
    return { folder, trusted: session!.trusted, files: projectCode(folder).files, trustedFolders: Object.entries(settings.trust ?? {}).map(([path, { added }]) => ({ path, added })) };
  });
  ipcMain.handle('frame-studio:trust-ask', async (event) => {
    const folder = viewerProject(event);
    if (!folder || session!.trusted) return null;
    const real = await realpath(folder);
    const code = projectCode(real);
    if (!(await askTrust(folder, code.files))) return null;
    trustNow(real, code.hash);
    return openFolder(folder, { restart: true });
  });
  ipcMain.handle('frame-studio:trust-revoke', async (event, path: unknown) => {
    const folder = viewerProject(event);
    const parent = main;
    if (!folder || typeof path !== 'string' || !settings.trust?.[path] || !parent) return null;
    // A page can ask for this, and it can stop another project's agent, so the answer comes from a dialog no page can draw.
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      message: `Stop trusting ${basename(path)}?`,
      detail: 'Its code stops loading, and if the project is open it closes and reopens without it, which stops any agent working there.',
      buttons: ['Stop Trusting', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return null;
    settings.trust = Object.fromEntries(Object.entries(settings.trust).filter(([p]) => p !== path));
    await saveSettings();
    const open = [...sessions.values()].find((s) => existsSync(s.folder) && realpathSync(s.folder) === path);
    if (!open) return null;
    // No need to ask: you just said no. It stays closed to its code until you trust it again.
    open.trusted = false;
    declined.set(path, projectCode(path).hash);
    return open === session ? openFolder(open.folder, { restart: true }) : (stopSession(open), null);
  });
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
  nativeTheme.on('updated', () => main?.setBackgroundColor(pageColour()));
  // The Dock icon with no window up: the viewer if a folder is open, else the welcome screen.
  app.on('activate', () => {
    if (main || welcome) return;
    if (session) showViewer(session.url, basename(session.folder));
    else showWelcome();
  });
  app.on('before-quit', () => {
    if (main && !main.isDestroyed()) settings.bounds = main.getBounds();
    for (const s of [...sessions.values()]) keepTrust(s);
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
    // The last project that's still there.
    for (const dir of settings.recent) {
      if (!(await isDirectory(dir))) continue;
      if (!(await openFolder(dir))) return;
      break;
    }
    showWelcome();
  });
}
