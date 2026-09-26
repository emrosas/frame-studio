// The updater's steps that need no Electron (ADR 0009): reading and writing
// electron-builder's latest-mac.yml, comparing versions, checking a download,
// deciding whether the app can replace itself where it is, unpacking the new
// app beside it, and the shell script that swaps the two once the app has
// quit. Node only, so the unit tests run them against temporary folders.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The bundle's name in every release zip. */
export const APP_NAME = 'Frame Studio.app';

/** What install says when the app runs from somewhere it can't replace itself. */
export const MOVE_FIRST = 'Move Frame Studio to your Applications folder, then update.';

/** One file a release offers. */
export interface FeedFile {
  /** Relative to the feed's own URL. */
  url: string;
  /** Base64 SHA-512 of the file. */
  sha512: string;
  size: number;
}

/** latest-mac.yml, the shape electron-builder writes and electron-updater reads. */
export interface Feed {
  version: string;
  files: FeedFile[];
  releaseDate?: string;
}

// ---- versions ----

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not a version like 1.2.3.`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Negative when `a` comes before `b`, positive after, 0 when equal. Semver order: 1.0.0-beta.2 < 1.0.0 < 1.0.1. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  // A prerelease comes before its release.
  if (!x.pre.length || !y.pre.length) return Number(!x.pre.length) - Number(!y.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- the feed ----

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Reads latest-mac.yml. Not a YAML parser: it knows the one shape electron-builder writes, top-level
 * `key: value` lines and a `files:` list of flat mappings, and throws on anything else.
 */
export function parseFeed(text: string): Feed {
  const top = new Map<string, string>();
  const lists = new Map<string, Map<string, string>[]>();
  let list: Map<string, string>[] | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const m = /^( *)(- +)?([A-Za-z0-9_]+):(?: +(.*))?$/.exec(line);
    if (!m) throw new Error(`latest-mac.yml line ${i + 1} is not "key: value": ${line}`);
    const [, indent, dash, key, raw = ''] = m;
    if (!indent && !dash) {
      list = null;
      if (raw.trim()) top.set(key, unquote(raw.trim()));
      else lists.set(key, (list = []));
      return;
    }
    if (!list) throw new Error(`latest-mac.yml line ${i + 1} is indented under nothing: ${line}`);
    if (dash) list.push(new Map());
    const item = list.at(-1);
    if (!item) throw new Error(`latest-mac.yml line ${i + 1} is outside any list item: ${line}`);
    item.set(key, unquote(raw.trim()));
  });
  const version = top.get('version');
  if (!version) throw new Error('latest-mac.yml has no version.');
  parseVersion(version);
  const files = (lists.get('files') ?? []).map((item, n): FeedFile => {
    const url = item.get('url');
    const sha512 = item.get('sha512');
    const size = Number(item.get('size'));
    if (!url || !sha512 || !Number.isSafeInteger(size) || size < 0) throw new Error(`latest-mac.yml file ${n + 1} needs a url, a sha512 and a size.`);
    return { url, sha512, size };
  });
  const releaseDate = top.get('releaseDate');
  return { version, files, ...(releaseDate ? { releaseDate } : {}) };
}

/** Writes latest-mac.yml for one zip, as electron-builder does. */
export function formatFeed(version: string, zip: FeedFile, releaseDate: string): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${zip.url}`,
    `    sha512: ${zip.sha512}`,
    `    size: ${zip.size}`,
    `path: ${zip.url}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

/** The zip a feed offers for Apple silicon: the first zip named arm64, else the first zip. */
export function zipOf(feed: Feed): FeedFile {
  const zips = feed.files.filter((f) => /\.zip$/i.test(f.url));
  const zip = zips.find((f) => /arm64/.test(f.url)) ?? zips[0];
  if (!zip) throw new Error(`The update feed for ${feed.version} lists no zip.`);
  return zip;
}

// ---- the download ----

/** The base64 SHA-512 of a file, as the feed writes it. */
export async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

/** Why `file` isn't the one the feed describes, or null when it is. */
export async function checkDownload(file: string, want: { sha512: string; size: number }): Promise<string | null> {
  const size = (await stat(file)).size;
  if (size !== want.size) return `The download is ${size} bytes, and the feed says ${want.size}.`;
  if ((await sha512Of(file)) !== want.sha512) return "The download's SHA-512 doesn't match the feed's.";
  return null;
}

// ---- where the app runs ----

/** The .app bundle an executable belongs to (…/Frame Studio.app/Contents/MacOS/Frame Studio), or null. */
export function bundleOf(executable: string): string | null {
  const bundle = resolve(dirname(executable), '../..');
  return bundle.endsWith('.app') ? bundle : null;
}

/** Why the app at `bundle` can't replace itself where it is, or null when it can. */
export async function whyCantUpdate(bundle: string): Promise<string | null> {
  // macOS runs a quarantined app that was never moved from a read-only copy at a random path.
  if (bundle.includes('/AppTranslocation/')) return MOVE_FIRST;
  const parent = dirname(bundle);
  const code = await access(parent, constants.W_OK).then(
    () => null,
    (err: NodeJS.ErrnoException) => err.code ?? 'EACCES',
  );
  if (!code) return null;
  // The disk image it came on, or another read-only volume.
  if (code === 'EROFS' || parent.startsWith('/Volumes/')) return MOVE_FIRST;
  return `Frame Studio can't write to ${parent}. Download the new version from the release page.`;
}

/** Where an update to `bundle` unpacks: a hidden folder beside it, on the same volume, so the swap is a rename. */
export function stagingFor(bundle: string, version: string): string {
  return join(dirname(bundle), `.${basename(bundle, '.app')}.update-${version}`);
}

// ---- unpacking ----

/** Reads `key` from a bundle's Info.plist. */
export async function plistValue(bundle: string, key: string): Promise<string> {
  const plist = join(bundle, 'Contents/Info.plist');
  try {
    return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
  } catch {
    throw new Error(`${plist} has no ${key}.`);
  }
}

/**
 * Unpacks the update `zip` into `staging` and checks it holds exactly one Frame Studio.app, with bundle id
 * `identifier` and version `version`. Returns the new app's path. On a failure `staging` is gone.
 */
export async function unpackUpdate(zip: string, staging: string, want: { identifier: string; version: string }): Promise<string> {
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging);
    // ditto keeps the frameworks' symlinks and the executable bits.
    await run('/usr/bin/ditto', ['-x', '-k', zip, staging]).catch((err: Error & { stderr?: string }) => {
      throw new Error(`The update didn't unpack: ${err.stderr?.trim() || err.message}`);
    });
    const apps = (await readdir(staging)).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1 || apps[0] !== APP_NAME) throw new Error(`The update holds ${apps.length ? apps.join(', ') : 'no app'}, where it should hold one ${APP_NAME}.`);
    const next = join(staging, APP_NAME);
    const identifier = await plistValue(next, 'CFBundleIdentifier');
    if (identifier !== want.identifier) throw new Error(`The update is ${identifier}, not ${want.identifier}.`);
    const version = await plistValue(next, 'CFBundleShortVersionString');
    if (version !== want.version) throw new Error(`The update holds version ${version}, and the feed says ${want.version}.`);
    // A quarantined app would meet Gatekeeper again at launch.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => {});
    return next;
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ---- the swap ----

/** Quotes a string for /bin/sh. */
export function sh(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export interface Swap {
  /** The running app's bundle, replaced in place. */
  app: string;
  /** The new bundle, inside `staging`. */
  next: string;
  /** Removed at the end, whatever happened. */
  staging: string;
  /** The app's process. The swap starts once it has ended. */
  pid: number;
  /** Seconds to wait for it before giving up. */
  timeout: number;
  /** A shell command that opens the app again. */
  relaunch: string;
}

/**
 * A /bin/sh script that waits for `pid` to end, moves the old bundle aside, moves the new one into its place and
 * deletes the old one. If a move fails it puts the old bundle back. It always removes the staging folder, and
 * then relaunches, unless the app never quit.
 */
export function swapScript(swap: Swap): string {
  return `APP=${sh(swap.app)}
NEXT=${sh(swap.next)}
OLD=${sh(`${swap.app}.old-${swap.pid}`)}
STAGING=${sh(swap.staging)}
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
say "updating $APP once process ${swap.pid} quits"
tries=0
while kill -0 ${swap.pid} 2>/dev/null; do
  if [ "$tries" -ge ${Math.round(swap.timeout * 10)} ]; then
    say "process ${swap.pid} is still running after ${swap.timeout} s; leaving the app as it is"
    rm -rf "$STAGING"
    exit 1
  fi
  sleep 0.1
  tries=$((tries + 1))
done
if mv "$APP" "$OLD"; then
  if mv "$NEXT" "$APP"; then
    rm -rf "$OLD"
    say "updated $APP"
  else
    say "could not move the new app into place; putting the old one back"
    if [ -e "$APP" ]; then rm -rf "$APP"; fi
    mv "$OLD" "$APP" || say "could not put the old app back; it is at $OLD"
  fi
else
  say "could not move $APP aside; leaving it as it is"
fi
rm -rf "$STAGING"
say "relaunching"
${swap.relaunch}
`;
}

/** Whether this macOS's open(1) takes --env. */
export async function openTakesEnv(): Promise<boolean> {
  // open -h with no names prints the usage and fails.
  const usage = await run('/usr/bin/open', ['-h']).then(
    ({ stdout, stderr }) => stdout + stderr,
    (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ''}${err.stderr ?? ''}`,
  );
  return usage.includes('--env');
}

/**
 * The command that opens the app at `bundle` as a new instance, with `env` when open(1) can pass it: an app
 * opened through Launch Services starts with launchd's environment, not ours.
 */
export function relaunchCommand(bundle: string, env: Record<string, string>, passEnv: boolean): string {
  const vars = passEnv ? Object.entries(env).map(([key, value]) => `--env ${sh(`${key}=${value}`)}`) : [];
  return ['/usr/bin/open', '-n', ...vars, sh(bundle)].join(' ');
}
