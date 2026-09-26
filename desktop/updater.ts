// Updates for the unsigned app (ADR 0009). The app reads electron-builder's
// latest-mac.yml from the latest GitHub release 10 s after launch, every 4
// hours, and from the app menu. Update downloads the release's zip, checks it
// against the feed, unpacks it beside the app, and hands the swap to a shell
// script that runs once the app has quit and then opens the new version.
// Electron main process only; the steps that need no Electron are in
// update-steps.ts.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, type MessageBoxOptions, net, shell } from 'electron';
import type { UpdateState } from '../src/viewer/desktop.ts';
import {
  bundleOf,
  checkDownload,
  compareVersions,
  type FeedFile,
  openTakesEnv,
  parseFeed,
  plistValue,
  relaunchCommand,
  stagingFor,
  swapScript,
  unpackUpdate,
  whyCantUpdate,
  zipOf,
} from './update-steps.ts';

export type { UpdateState };

const RELEASES = 'https://github.com/emrosas/frame-studio/releases';
const FIRST_CHECK = 10_000;
const EVERY = 4 * 60 * 60 * 1000;
/** How long the swap script waits for the app to quit, in seconds. */
const QUIT_TIMEOUT = 60;
/** A download that sends nothing for this long is given up. */
const STALL = 60_000;
const FROM_SOURCE = "This copy of Frame Studio runs from source, so it can't replace itself. Download the new version from the release page.";

interface Release {
  version: string;
  zip: FeedFile;
  /** The zip's absolute URL. */
  url: string;
}

let state: UpdateState = { status: 'idle' };
/** The newer release the last check found. */
let latest: Release | null = null;
let fetching: Promise<Release> | null = null;
let push: (state: UpdateState) => void = () => {};
let log: (line: string) => void = () => {};

const notesFor = (version: string) => `${RELEASES}/tag/v${version}`;
const busy = () => state.status === 'downloading' || state.status === 'restarting';
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

function set(next: UpdateState): void {
  state = next;
  push(next);
}

/** Only the installed app checks, or any app pointed at a test feed. Never the render worker, which never gets here. */
export function updatesEnabled(): boolean {
  return process.platform === 'darwin' && (app.isPackaged || Boolean(process.env.FRAME_STUDIO_UPDATE_FEED));
}

function feedUrl(): string {
  const base = process.env.FRAME_STUDIO_UPDATE_FEED ?? `${RELEASES}/latest/download/`;
  return new URL('latest-mac.yml', base.endsWith('/') ? base : `${base}/`).href;
}

async function fetchLatest(): Promise<Release> {
  const url = feedUrl();
  // GitHub redirects latest/download/ to the newest release that is neither a draft nor a prerelease.
  const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The update feed answered ${res.status} (${url}).`);
  const feed = parseFeed(await res.text());
  const zip = zipOf(feed);
  return { version: feed.version, zip, url: new URL(zip.url, url).href };
}

/** Starts the checks, and sends every state change to `hooks.push`. */
export function startUpdates(hooks: { push(state: UpdateState): void; log(line: string): void }): void {
  push = hooks.push;
  log = hooks.log;
  setTimeout(() => {
    void checkForUpdates(false);
    setInterval(() => void checkForUpdates(false), EVERY);
  }, FIRST_CHECK);
}

export function updateState(): UpdateState {
  return state;
}

/**
 * Checks the feed. A check the user asked for shows `checking` and ends in `error` when it fails; a background
 * check only logs its failures, so an offline laptop doesn't show an error every 4 hours.
 */
export async function checkForUpdates(user: boolean): Promise<UpdateState> {
  if (busy()) return state;
  if (user) set({ status: 'checking' });
  try {
    fetching ??= fetchLatest().finally(() => {
      fetching = null;
    });
    const found = await fetching;
    // An install started meanwhile.
    if (busy()) return state;
    latest = compareVersions(found.version, app.getVersion()) > 0 ? found : null;
    set(latest ? { status: 'available', version: latest.version, notes: notesFor(latest.version) } : { status: 'idle' });
  } catch (err) {
    log(`update check: ${why(err)}`);
    if (user) set({ status: 'error', message: `Couldn't check for updates. ${why(err)}` });
  }
  return state;
}

/** Downloads `release`'s zip to `file`, with progress, refusing more bytes than the feed says. */
async function download(release: Release, file: string, progress: (done: number) => void): Promise<void> {
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL);
  const out = await open(file, 'w');
  try {
    const res = await net.fetch(release.url, { cache: 'no-store', signal: stall.signal });
    if (!res.ok || !res.body) throw new Error(`The download answered ${res.status} (${release.url}).`);
    const reader = res.body.getReader();
    let done = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), STALL);
      done += chunk.value.byteLength;
      if (done > release.zip.size) {
        await reader.cancel().catch(() => {});
        throw new Error(`The download is larger than the ${release.zip.size} bytes the feed says.`);
      }
      await out.write(chunk.value);
      progress(done);
    }
  } catch (err) {
    throw stall.signal.aborted ? new Error(`The download stopped: nothing arrived for ${STALL / 1000} s.`) : err;
  } finally {
    clearTimeout(timer);
    await out.close();
  }
}

/** Starts the swap script, detached, so it outlives the app. Its output goes to update.log. */
async function startSwap(bundle: string, next: string, staging: string): Promise<void> {
  const env: Record<string, string> = {};
  // Tests run the app on a temporary settings folder and feed; the relaunched app keeps them.
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith('FRAME_STUDIO_') && value !== undefined) env[key] = value;
  const script = swapScript({ app: bundle, next, staging, pid: process.pid, timeout: QUIT_TIMEOUT, relaunch: relaunchCommand(bundle, env, await openTakesEnv()) });
  const out = openSync(join(app.getPath('logs'), 'update.log'), 'a');
  try {
    // The system's own tools, not whatever the login shell put first on PATH.
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', out, out], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() } });
    child.unref();
  } finally {
    closeSync(out);
  }
}

/**
 * Update: download the newer release, check it, unpack it beside the app, then quit and let the swap script
 * replace the app and open it again. Progress and failures arrive as states. Anything that fails before the quit
 * leaves the installed app as it was.
 */
export async function installUpdate(): Promise<void> {
  if (busy()) return;
  if (!latest) await checkForUpdates(true);
  const release = latest;
  if (!release || busy()) return;
  const about = { version: release.version, notes: notesFor(release.version) };
  const bundle = app.isPackaged ? bundleOf(process.execPath) : null;
  const problem = bundle ? await whyCantUpdate(bundle) : FROM_SOURCE;
  if (problem || !bundle) {
    set({ status: 'error', message: problem ?? FROM_SOURCE, manual: true, ...about });
    return;
  }
  const temp = await mkdtemp(join(app.getPath('temp'), 'frame-studio-update-'));
  try {
    const total = release.zip.size;
    set({ status: 'downloading', ...about, done: 0, total });
    let pushed = 0;
    const zip = join(temp, 'update.zip');
    await download(release, zip, (done) => {
      // About ten a second is plenty for a progress bar.
      if (Date.now() - pushed < 100 && done < total) return;
      pushed = Date.now();
      set({ status: 'downloading', ...about, done, total });
    });
    const bad = await checkDownload(zip, release.zip);
    if (bad) throw new Error(bad);
    const staging = stagingFor(bundle, release.version);
    const next = await unpackUpdate(zip, staging, { identifier: await plistValue(bundle, 'CFBundleIdentifier'), version: release.version });
    try {
      await startSwap(bundle, next, staging);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    log(`update: ${app.getVersion()} to ${release.version}, restarting`);
    set({ status: 'restarting', version: release.version });
    // A moment for the windows to show it.
    setTimeout(() => app.quit(), 300);
  } catch (err) {
    log(`update: ${why(err)}`);
    set({ status: 'error', message: why(err), ...about });
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Opens the release page of the version on offer, or the releases list. */
export async function openReleaseNotes(): Promise<void> {
  const notes = 'notes' in state && state.notes ? state.notes : latest ? notesFor(latest.version) : RELEASES;
  await shell.openExternal(notes);
}

async function ask(options: MessageBoxOptions): Promise<number> {
  const parent = BrowserWindow.getFocusedWindow();
  return (parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)).response;
}

/** Update, from the menu: says why it failed, since there may be no page up to show it. */
async function installFromMenu(): Promise<void> {
  await installUpdate();
  if (state.status !== 'error') return;
  const manual = state.manual === true;
  const choice = await ask({ type: 'warning', message: "Frame Studio couldn't update.", detail: state.message, buttons: manual ? ['Open Release Page', 'OK'] : ['OK'], defaultId: 0 });
  if (manual && choice === 0) await openReleaseNotes();
}

/** App menu › Check for Updates…: says what it found, and offers Update when there is one. */
export async function checkFromMenu(): Promise<void> {
  const found = await checkForUpdates(true);
  if (found.status === 'idle') {
    await ask({ type: 'info', message: `Frame Studio ${app.getVersion()} is the newest version.`, buttons: ['OK'] });
  } else if (found.status === 'error') {
    await ask({ type: 'warning', message: "Frame Studio couldn't check for updates.", detail: found.message.replace(/^Couldn't check for updates\. /, ''), buttons: ['OK'] });
  } else if (found.status === 'available') {
    const choice = await ask({
      type: 'info',
      message: `Frame Studio ${found.version} is available.`,
      detail: `You have ${app.getVersion()}. Update downloads it, replaces this copy and restarts.`,
      buttons: ['Update', 'Release Notes', 'Later'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) await installFromMenu();
    else if (choice === 1) await openReleaseNotes();
  }
}
