/**
 * ADR 0009: the packaged app updates itself. Skipped until npm run
 * desktop:build has built it. The test installs the built app in a temporary
 * Applications folder, from the release zip when there is one, makes a 99.0.0
 * copy, zips it as a release does, and serves it with a latest-mac.yml from a
 * local feed. The app runs on it with a temporary settings folder and home,
 * which the relaunched app keeps.
 *
 * - The viewer's bridge offers 99.0.0, and the welcome page has the same calls.
 * - A feed with the wrong checksum is refused, and the app on disk stays as it was.
 * - Update replaces the app in place, leaves nothing beside it, and opens the new one.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatFeed, type FeedFile, sha512Of } from '../../desktop/update-steps';
import type { DesktopUpdates, UpdateState } from '../../src/viewer/desktop';
import { REPO } from '../../tools/studio/folder';

const BUILT = join(REPO, 'build/desktop/dist/mac-arm64/Frame Studio.app');
const { version: built } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string };
/** Made by npm run desktop:build -- --release. */
const RELEASE_ZIP = join(REPO, `build/desktop/dist/Frame-Studio-${built}-arm64-mac.zip`);
const root = mkdtempSync(join(tmpdir(), 'frame-studio-packaged-update-'));
const apps = join(root, 'Applications');
const APP = join(apps, 'Frame Studio.app');
const BINARY = join(APP, 'Contents/MacOS/Frame Studio');
const home = join(root, 'home');
const userData = join(root, 'userdata');
const ZIP_NAME = 'Frame-Studio-99.0.0-arm64-mac.zip';
const NOTES = 'https://github.com/emrosas/frame-studio/releases/tag/v99.0.0';

let app: ElectronApplication | null = null;
let server: Server | null = null;
let feedUrl = '';
let zip: FeedFile = { url: ZIP_NAME, sha512: '', size: 0 };
/** What the feed serves as latest-mac.yml. */
let yml = '';
/** Every state the viewer was sent, in order. */
const pushes: UpdateState[] = [];

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') out[key] = value;
  return { ...out, FRAME_STUDIO_HOME: home, FRAME_STUDIO_USER_DATA: userData, FRAME_STUDIO_UPDATE_FEED: feedUrl, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

// Polled during the swap too, when the bundle is briefly missing, so its complaints stay quiet.
const version = (bundle: string) =>
  execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Pids of processes whose command line holds `pattern`. */
function running(pattern: string): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', '--', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function viewerWindow(electron: ElectronApplication): Promise<Page> {
  const isViewer = (p: Page) => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(p.url());
  const page = electron.windows().find(isViewer) ?? (await electron.waitForEvent('window', { predicate: isViewer, timeout: 60_000 }));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount !== undefined, undefined, { timeout: 60_000 });
  return page;
}

type Updates = { frameStudioDesktop?: { updates?: DesktopUpdates } };

beforeAll(async () => {
  if (!existsSync(BUILT)) return;
  mkdirSync(apps);
  mkdirSync(home);
  // Installed from the release zip when the build made one, which shows electron-builder's zip unpacks to an app
  // that starts. Otherwise a copy of the built app.
  if (existsSync(RELEASE_ZIP)) execFileSync('/usr/bin/ditto', ['-x', '-k', RELEASE_ZIP, apps]);
  else execFileSync('/usr/bin/ditto', [BUILT, APP]);
  // The release: the same app, calling itself 99.0.0, zipped as electron-builder zips it.
  const next = join(root, 'next/Frame Studio.app');
  execFileSync('/usr/bin/ditto', [BUILT, next]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', '99.0.0', join(next, 'Contents/Info.plist')]);
  mkdirSync(join(root, 'feed'));
  const file = join(root, 'feed', ZIP_NAME);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, file]);
  zip = { url: ZIP_NAME, sha512: await sha512Of(file), size: statSync(file).size };
  server = createServer((req, res) => {
    if (req.url === '/latest-mac.yml') {
      res.writeHead(200, { 'content-type': 'text/yaml' }).end(yml);
    } else if (req.url === `/${ZIP_NAME}`) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.size) });
      createReadStream(file).pipe(res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await app?.close().catch(() => {});
  // The relaunched app, its helpers and its server all run from the temporary folder.
  for (const signal of ['-TERM', '-KILL']) {
    try {
      execFileSync('/usr/bin/pkill', [signal, '-f', root]);
    } catch {
      // Nothing left.
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(BUILT))('updating the packaged app', () => {
  it('offers the newer version to the viewer, and to the welcome page', async () => {
    yml = formatFeed('99.0.0', zip, new Date().toISOString());
    const installed = version(APP);
    app = await _electron.launch({ executablePath: BINARY, args: [], env: env() });
    const welcome = await app.firstWindow();
    const appMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0].submenu?.items.map((item) => item.label || item.role || item.type));
    expect(appMenu?.slice(0, 3)).toEqual(['About Frame Studio', 'Check for Updates…', 'separator']);
    // The welcome page's calls get past main's check on who is asking.
    const first = await welcome.evaluate(() => (window as unknown as { frameStudioWelcome: { updates?: DesktopUpdates } }).frameStudioWelcome.updates?.state());
    expect(first?.status).toMatch(/^(idle|available)$/);
    await welcome.getByRole('button', { name: 'Open the sample project' }).click();
    const viewer = await viewerWindow(app);
    viewer.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('update-state ')) pushes.push(JSON.parse(text.slice('update-state '.length)) as UpdateState);
    });
    await viewer.evaluate(() => {
      (window as unknown as Updates).frameStudioDesktop!.updates!.onChange((state) => console.log(`update-state ${JSON.stringify(state)}`));
    });
    const found = await viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.check());
    expect(found).toEqual({ status: 'available', version: '99.0.0', notes: NOTES });
    expect(await viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.state())).toEqual(found);
    // The background check, 10 s after launch, may add an `available` of its own.
    await expect.poll(() => pushes.at(-1)).toEqual(found);
    expect(pushes.map((s) => s.status)).toContain('checking');
    expect(installed).not.toBe('99.0.0');
  });

  it('refuses a download whose checksum is not the one the feed gives, and leaves the app as it was', async () => {
    const before = version(APP);
    yml = formatFeed('99.0.0', { ...zip, sha512: Buffer.alloc(64, 7).toString('base64') }, new Date().toISOString());
    const viewer = await viewerWindow(app!);
    expect((await viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.check())).status).toBe('available');
    pushes.length = 0;
    await viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.install());
    await expect.poll(() => pushes.find((s) => s.status === 'error')).toMatchObject({ status: 'error', message: "The download's SHA-512 doesn't match the feed's.", version: '99.0.0' });
    const downloads = pushes.filter((s) => s.status === 'downloading');
    expect(downloads.at(-1)).toMatchObject({ done: zip.size, total: zip.size });
    expect(version(APP)).toBe(before);
    expect(readdirSync(apps)).toEqual(['Frame Studio.app']);
  });

  it('says from Check for Updates… when the app is up to date, when the check failed, and when there is an update', async () => {
    type Box = { message: string; detail?: string; buttons?: string[]; cancelId?: number };
    // Answer every message box in main with its last button: OK, or Later.
    await app!.evaluate(({ dialog }) => {
      const shown: Box[] = [];
      (globalThis as unknown as { shown: Box[] }).shown = shown;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const box = args.at(-1) as Box;
        shown.push({ message: box.message, detail: box.detail, buttons: box.buttons });
        return { response: box.cancelId ?? (box.buttons?.length ?? 1) - 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const check = () =>
      app!.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.items[0].submenu!.items.find((item) => item.label === 'Check for Updates…')!.click();
      });
    const shown = () => app!.evaluate(() => (globalThis as unknown as { shown: Box[] }).shown);
    const current = await app!.evaluate(({ app: electron }) => electron.getVersion());

    yml = formatFeed(current, zip, new Date().toISOString());
    await check();
    await expect.poll(async () => (await shown()).at(-1)?.message).toBe(`Frame Studio ${current} is the newest version.`);

    yml = 'not a feed';
    await check();
    await expect.poll(async () => (await shown()).at(-1)).toMatchObject({ message: "Frame Studio couldn't check for updates.", detail: expect.stringMatching(/^latest-mac\.yml line 1/) });

    yml = formatFeed('99.0.0', zip, new Date().toISOString());
    await check();
    await expect.poll(async () => (await shown()).at(-1)).toMatchObject({ message: 'Frame Studio 99.0.0 is available.', buttons: ['Update', 'Release Notes', 'Later'] });
    expect(await shown()).toHaveLength(3);
  });

  it('replaces the app in place and opens the new one', async () => {
    yml = formatFeed('99.0.0', zip, new Date().toISOString());
    const viewer = await viewerWindow(app!);
    expect((await viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.check())).status).toBe('available');
    pushes.length = 0;
    const closed = app!.waitForEvent('close', { timeout: 120_000 });
    void viewer.evaluate(() => (window as unknown as Updates).frameStudioDesktop!.updates!.install()).catch(() => {});
    await closed;
    app = null;
    expect(pushes.map((s) => s.status)).toContain('downloading');
    expect(pushes.at(-1)).toEqual({ status: 'restarting', version: '99.0.0' });
    await expect.poll(() => version(APP), { timeout: 60_000 }).toBe('99.0.0');
    await expect.poll(() => readdirSync(apps), { timeout: 30_000 }).toEqual(['Frame Studio.app']);
    await expect.poll(() => running(BINARY).length, { timeout: 60_000 }).toBeGreaterThan(0);
    // It kept the temporary settings folder: without it, it would have met your own app's single-instance lock and quit.
    await expect.poll(() => running(`--user-data-dir=${userData}`).length, { timeout: 60_000 }).toBeGreaterThan(0);
    await new Promise((done) => setTimeout(done, 2000));
    expect(running(BINARY).length).toBeGreaterThan(0);
    const log = readFileSync(join(userData, 'logs/update.log'), 'utf8');
    expect(log).toMatch(/updated .*Frame Studio\.app/);
    expect(log).toMatch(/relaunching/);
  });
});
