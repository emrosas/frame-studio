/**
 * The updater's steps (ADR 0009), against temporary folders: reading
 * latest-mac.yml, comparing versions, checking a download against the feed,
 * where the app can replace itself, unpacking an update, and the swap script,
 * run for real on stand-in bundles.
 */
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleOf,
  checkDownload,
  compareVersions,
  formatFeed,
  MOVE_FIRST,
  openTakesEnv,
  parseFeed,
  relaunchCommand,
  sha512Of,
  stagingFor,
  swapScript,
  unpackUpdate,
  whyCantUpdate,
  zipOf,
} from '../../desktop/update-steps';

const run = promisify(execFile);
const mac = process.platform === 'darwin';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-updater-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in Frame Studio.app: an Info.plist, a file saying which one it is, and a framework symlink. */
function fakeApp(at: string, options: { id?: string; version?: string; mark?: string } = {}): string {
  mkdirSync(join(at, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(at, 'Contents/Frameworks/Some.framework/Versions/A'), { recursive: true });
  symlinkSync('A', join(at, 'Contents/Frameworks/Some.framework/Versions/Current'));
  writeFileSync(
    join(at, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${options.id ?? 'studio.frame.app'}</string>
<key>CFBundleShortVersionString</key><string>${options.version ?? '0.2.0'}</string>
</dict></plist>
`,
  );
  writeFileSync(join(at, 'Contents/MacOS/mark'), options.mark ?? 'old');
  return at;
}

const mark = (app: string) => readFileSync(join(app, 'Contents/MacOS/mark'), 'utf8');

describe('the feed', () => {
  // As electron-builder writes it for a release with a zip and a DMG.
  const builderFeed = `version: 0.2.0
files:
  - url: Frame-Studio-0.2.0-arm64-mac.zip
    sha512: 3q2+7w==
    size: 123456
    blockMapSize: 1300
  - url: Frame-Studio-0.2.0-arm64.dmg
    sha512: "3q2+7w=="
    size: 234567
path: Frame-Studio-0.2.0-arm64-mac.zip
sha512: 3q2+7w==
releaseDate: '2026-09-26T12:00:00.000Z'
`;

  it("reads electron-builder's latest-mac.yml and picks the zip", () => {
    const feed = parseFeed(builderFeed);
    expect(feed.version).toBe('0.2.0');
    expect(feed.releaseDate).toBe('2026-09-26T12:00:00.000Z');
    expect(feed.files).toEqual([
      { url: 'Frame-Studio-0.2.0-arm64-mac.zip', sha512: '3q2+7w==', size: 123456 },
      { url: 'Frame-Studio-0.2.0-arm64.dmg', sha512: '3q2+7w==', size: 234567 },
    ]);
    expect(zipOf(feed).url).toBe('Frame-Studio-0.2.0-arm64-mac.zip');
  });

  it('reads what the release script writes', () => {
    const zip = { url: 'Frame-Studio-1.0.0-arm64-mac.zip', sha512: 'a'.repeat(86) + '==', size: 99 };
    const text = formatFeed('1.0.0', zip, '2026-09-26T12:00:00.000Z');
    expect(text).toContain("releaseDate: '2026-09-26T12:00:00.000Z'");
    expect(parseFeed(text)).toEqual({ version: '1.0.0', files: [zip], releaseDate: '2026-09-26T12:00:00.000Z' });
  });

  it('takes a list with no indent, CRLF lines and comments', () => {
    const feed = parseFeed('# a comment\r\nversion: "1.2.3"\r\nfiles:\r\n- url: a.zip\r\n  sha512: x\r\n  size: 1\r\n');
    expect(feed).toEqual({ version: '1.2.3', files: [{ url: 'a.zip', sha512: 'x', size: 1 }] });
  });

  it('prefers the arm64 zip when a feed has one for each architecture', () => {
    const feed = parseFeed('version: 1.0.0\nfiles:\n  - url: A-1.0.0-mac.zip\n    sha512: x\n    size: 1\n  - url: A-1.0.0-arm64-mac.zip\n    sha512: y\n    size: 2\n');
    expect(zipOf(feed).sha512).toBe('y');
  });

  it('refuses feeds it cannot trust', () => {
    expect(() => parseFeed('files:\n  - url: a.zip\n    sha512: x\n    size: 1\n')).toThrow(/no version/);
    expect(() => parseFeed('version: latest\n')).toThrow(/not a version/);
    expect(() => parseFeed('version: 1.0.0\nfiles:\n  - url: a.zip\n    size: 1\n')).toThrow(/needs a url, a sha512 and a size/);
    expect(() => parseFeed('version: 1.0.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: lots\n')).toThrow(/needs a url, a sha512 and a size/);
    expect(() => parseFeed('version: 1.0.0\n  stray: 1\n')).toThrow(/indented under nothing/);
    expect(() => parseFeed('version: 1.0.0\n{ "json": true }\n')).toThrow(/line 2/);
    expect(() => zipOf(parseFeed('version: 1.0.0\nfiles:\n  - url: a.dmg\n    sha512: x\n    size: 1\n'))).toThrow(/no zip/);
  });
});

describe('versions', () => {
  it('orders versions as semver does', () => {
    const ordered = ['0.0.0', '0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '0.10.0', '1.0.0', '10.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) expect(Math.sign(compareVersions(ordered[i], ordered[j])), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
    }
  });

  it('ignores a leading v and build metadata, and refuses anything else', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
    expect(() => compareVersions('1.2', '1.2.0')).toThrow(/not a version/);
    expect(() => compareVersions('1.2.3', 'next')).toThrow(/not a version/);
  });
});

describe('the download', () => {
  it('passes a file with the size and SHA-512 the feed gives, and refuses any other', async () => {
    const file = join(dir, 'update.zip');
    writeFileSync(file, 'the new app');
    // Worked out by openssl, not by the code under test.
    const sha512 = (await run('/bin/sh', ['-c', `openssl dgst -sha512 -binary ${JSON.stringify(file)} | openssl base64 -A`])).stdout.trim();
    expect(await sha512Of(file)).toBe(sha512);
    expect(await checkDownload(file, { sha512, size: 11 })).toBeNull();
    expect(await checkDownload(file, { sha512, size: 12 })).toMatch(/11 bytes, and the feed says 12/);
    writeFileSync(file, 'the old app');
    expect(await checkDownload(file, { sha512, size: 11 })).toMatch(/SHA-512 doesn't match/);
  });
});

describe('where the app can update', () => {
  it('finds the bundle an executable belongs to', () => {
    expect(bundleOf('/Applications/Frame Studio.app/Contents/MacOS/Frame Studio')).toBe('/Applications/Frame Studio.app');
    expect(bundleOf('/usr/local/bin/electron')).toBeNull();
    expect(stagingFor('/Applications/Frame Studio.app', '0.2.0')).toBe('/Applications/.Frame Studio.update-0.2.0');
  });

  it('updates in a folder it can write to', async () => {
    expect(await whyCantUpdate(join(dir, 'Frame Studio.app'))).toBeNull();
  });

  it('asks to be moved to Applications when macOS runs it translocated, or from the disk image', async () => {
    expect(await whyCantUpdate('/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/Frame Studio.app')).toBe(MOVE_FIRST);
    expect(await whyCantUpdate('/Volumes/Frame Studio/Frame Studio.app')).toBe(MOVE_FIRST);
  });

  it("says which folder it can't write to", async () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      expect(await whyCantUpdate(join(locked, 'Frame Studio.app'))).toBe(`Frame Studio can't write to ${locked}. Download the new version from the release page.`);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe.skipIf(!mac)('unpacking', () => {
  /** Zips a stand-in app as a release does, and returns the zip. */
  async function zipOfApp(options: Parameters<typeof fakeApp>[1] = {}, name = 'Frame Studio.app'): Promise<string> {
    const src = join(dir, 'src');
    rmSync(src, { recursive: true, force: true });
    fakeApp(join(src, name), options);
    const zip = join(dir, 'update.zip');
    rmSync(zip, { force: true });
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(src, name), zip]);
    return zip;
  }

  const want = { identifier: 'studio.frame.app', version: '0.2.0' };

  it('unpacks the new app with its symlinks, and checks its id and version', async () => {
    const zip = await zipOfApp({ mark: 'new' });
    const staging = join(dir, 'Applications/.Frame Studio.update-0.2.0');
    mkdirSync(join(dir, 'Applications'));
    const next = await unpackUpdate(zip, staging, want);
    expect(next).toBe(join(staging, 'Frame Studio.app'));
    expect(mark(next)).toBe('new');
    expect(readlinkSync(join(next, 'Contents/Frameworks/Some.framework/Versions/Current'))).toBe('A');
  });

  it('refuses an app of another version, another id or another name, and leaves no staging folder', async () => {
    const staging = join(dir, 'staging');
    await expect(unpackUpdate(await zipOfApp({ version: '0.1.9' }), staging, want)).rejects.toThrow(/version 0\.1\.9, and the feed says 0\.2\.0/);
    expect(existsSync(staging)).toBe(false);
    await expect(unpackUpdate(await zipOfApp({ id: 'com.example.other' }), staging, want)).rejects.toThrow(/com\.example\.other, not studio\.frame\.app/);
    expect(existsSync(staging)).toBe(false);
    await expect(unpackUpdate(await zipOfApp({}, 'Other.app'), staging, want)).rejects.toThrow(/holds Other\.app/);
    expect(existsSync(staging)).toBe(false);
    writeFileSync(join(dir, 'broken.zip'), 'not a zip');
    await expect(unpackUpdate(join(dir, 'broken.zip'), staging, want)).rejects.toThrow(/didn't unpack/);
    expect(existsSync(staging)).toBe(false);
  });
});

describe('the swap script', () => {
  let apps: string;
  let app: string;
  let staging: string;
  let next: string;
  const relaunched = () => join(dir, 'relaunched');

  beforeEach(() => {
    apps = join(dir, 'Applications');
    app = fakeApp(join(apps, 'Frame Studio.app'), { mark: 'old' });
    staging = stagingFor(app, '0.2.0');
    next = fakeApp(join(staging, 'Frame Studio.app'), { mark: 'new' });
  });

  /** Runs the swap for `pid`, relaunching by touching a file. */
  function swap(pid: number, options: { next?: string; timeout?: number } = {}) {
    const script = swapScript({ app, next: options.next ?? next, staging, pid, timeout: options.timeout ?? 10, relaunch: `touch '${relaunched()}'` });
    return run('/bin/sh', ['-c', script]).then(
      (r) => ({ code: 0, out: r.stdout }),
      (err: { code: number; stdout: string }) => ({ code: err.code, out: err.stdout }),
    );
  }

  /** A process that ends after `seconds`, and a promise for its end. */
  function shortLived(seconds: number) {
    const child = spawn('sleep', [String(seconds)], { stdio: 'ignore' });
    const ended = new Promise<void>((done) => child.once('exit', () => done()));
    return { pid: child.pid!, ended, kill: () => child.kill() };
  }

  it('puts the new app in place of the old one, cleans up and relaunches', async () => {
    const gone = shortLived(0);
    await gone.ended;
    const result = await swap(gone.pid);
    expect(result.code, result.out).toBe(0);
    expect(mark(app)).toBe('new');
    expect(readdirSync(apps)).toEqual(['Frame Studio.app']);
    expect(existsSync(relaunched())).toBe(true);
    expect(result.out).toMatch(/updated .*Frame Studio\.app/);
  });

  it('waits for the app to quit before touching it', async () => {
    const running = shortLived(1.5);
    const swapped = swap(running.pid);
    await new Promise((done) => setTimeout(done, 700));
    expect(mark(app)).toBe('old');
    expect(existsSync(relaunched())).toBe(false);
    await running.ended;
    const result = await swapped;
    expect(result.code, result.out).toBe(0);
    expect(mark(app)).toBe('new');
    expect(existsSync(relaunched())).toBe(true);
  });

  it('gives up, leaving the app alone, when the app never quits', async () => {
    const stuck = shortLived(30);
    try {
      const result = await swap(stuck.pid, { timeout: 0.5 });
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/still running after 0\.5 s/);
      expect(mark(app)).toBe('old');
      expect(readdirSync(apps)).toEqual(['Frame Studio.app']);
      expect(existsSync(relaunched())).toBe(false);
    } finally {
      stuck.kill();
    }
  });

  it('puts the old app back when the new one cannot move in, and still cleans up and relaunches', async () => {
    const gone = shortLived(0);
    await gone.ended;
    const result = await swap(gone.pid, { next: join(staging, 'Missing.app') });
    expect(result.out).toMatch(/putting the old one back/);
    expect(mark(app)).toBe('old');
    expect(readdirSync(apps)).toEqual(['Frame Studio.app']);
    expect(existsSync(relaunched())).toBe(true);
  });

  it('leaves the app as it is when it cannot move it aside', async () => {
    const gone = shortLived(0);
    await gone.ended;
    chmodSync(apps, 0o555);
    try {
      const result = await swap(gone.pid);
      expect(result.out).toMatch(/could not move .* aside/);
      expect(mark(app)).toBe('old');
      expect(readdirSync(apps)).toContain('Frame Studio.app');
      expect(readdirSync(apps).filter((name) => name.includes('.old-'))).toEqual([]);
    } finally {
      chmodSync(apps, 0o755);
    }
  });

  it('quotes paths with spaces and quotes', async () => {
    const odd = join(dir, "Bob's Apps");
    mkdirSync(odd);
    app = fakeApp(join(odd, 'Frame Studio.app'), { mark: 'old' });
    staging = stagingFor(app, '0.2.0');
    next = fakeApp(join(staging, 'Frame Studio.app'), { mark: 'new' });
    const gone = shortLived(0);
    await gone.ended;
    const result = await swap(gone.pid);
    expect(result.code, result.out).toBe(0);
    expect(mark(app)).toBe('new');
    expect(readdirSync(odd)).toEqual(['Frame Studio.app']);
  });
});

describe('relaunching', () => {
  it('opens a new instance, passing the environment on when open(1) can', () => {
    const app = "/Users/me/Bob's Apps/Frame Studio.app";
    expect(relaunchCommand(app, { FRAME_STUDIO_HOME: '/tmp/a b' }, true)).toBe(`/usr/bin/open -n --env 'FRAME_STUDIO_HOME=/tmp/a b' '/Users/me/Bob'\\''s Apps/Frame Studio.app'`);
    expect(relaunchCommand(app, { FRAME_STUDIO_HOME: '/tmp/a b' }, false)).toBe(`/usr/bin/open -n '/Users/me/Bob'\\''s Apps/Frame Studio.app'`);
  });

  it.skipIf(!mac)("reads open(1)'s usage to see whether it takes --env", async () => {
    expect(typeof (await openTakesEnv())).toBe('boolean');
  });
});
