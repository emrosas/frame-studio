// npm run desktop:release: builds a release of the app (ADR 0009) for
// package.json's version, and with --publish puts it on GitHub. docs/RELEASING.md
// has the steps around it.
//
// It refuses when the tag v<version> is already on origin, when HEAD isn't on
// origin/main, or when a file that ships in the app has uncommitted changes.
// Then it builds with tools/desktop/package.ts --release, checks that the zip
// unpacks to an app of this version with its framework symlinks, and writes
// latest-mac.yml, the feed the updater reads, beside the zip and the DMG in
// build/desktop/dist/. Without --publish it prints the gh command instead.

import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { APP_NAME, formatFeed, plistValue, sh, sha512Of } from '../../desktop/update-steps.ts';
import { REPO } from '../studio/folder.ts';

const OUT = join(REPO, 'build/desktop/dist');
/** What goes into the app. Other files, such as test scenes, may have changes. */
const SHIPPED = ['src', 'desktop', 'tools', 'public', 'index.html', 'render.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'scenes/hello.json', 'projects/bears-story'];

const publish = process.argv.includes('--publish');
const { version } = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string };
const tag = `v${version}`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Runs a command in the repo and returns its output, or stops with its error. */
function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: REPO, encoding: 'utf8' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed:\n${result.stderr || result.error?.message || ''}`);
  return result.stdout;
}

// ---- refusals ----

run('git', ['fetch', '--quiet', 'origin']);
if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim()) fail(`${tag} is already on origin. Bump the version in package.json first.`);
if (spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: REPO }).status !== 0) fail('HEAD is not on origin/main. Push it, or check out a commit that is.');
const dirty = run('git', ['status', '--porcelain', '--', ...SHIPPED]).trimEnd();
if (dirty) fail(`These files ship in the app and have uncommitted changes:\n${dirty}`);
const head = run('git', ['rev-parse', 'HEAD']).trim();

// ---- the build ----

process.stderr.write(`Building Frame Studio ${version} at ${head.slice(0, 7)}\n`);
const build = spawnSync(process.execPath, [join(REPO, 'tools/desktop/package.ts'), '--release'], { cwd: REPO, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const zip = join(OUT, `Frame-Studio-${version}-arm64-mac.zip`);
const dmg = join(OUT, `Frame-Studio-${version}-arm64.dmg`);
for (const file of [zip, dmg]) await stat(file).catch(() => fail(`The build made no ${relative(REPO, file)}.`));

// ---- the zip, unpacked as the updater unpacks it ----

const scratch = await mkdtemp(join(tmpdir(), 'frame-studio-release-'));
try {
  run('/usr/bin/ditto', ['-x', '-k', zip, scratch]);
  const app = join(scratch, APP_NAME);
  const unpacked = await plistValue(app, 'CFBundleShortVersionString').catch((err: Error) => fail(`The zip doesn't hold ${APP_NAME}: ${err.message}`));
  if (unpacked !== version) fail(`The zip holds version ${unpacked}, not ${version}.`);
  // A zip that followed the symlinks would unpack to an app that doesn't start.
  const current = join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current');
  if (!(await lstat(current).then((s) => s.isSymbolicLink(), () => false))) fail(`The zip lost the frameworks' symlinks: ${relative(scratch, current)} is not one.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// ---- the feed ----

const feed = join(OUT, 'latest-mac.yml');
const size = (await stat(zip)).size;
await writeFile(feed, formatFeed(version, { url: `Frame-Studio-${version}-arm64-mac.zip`, sha512: await sha512Of(zip), size }, new Date().toISOString()));

const files = [zip, dmg, feed];
process.stdout.write(`\nFrame Studio ${version}:\n${files.map((f) => `  ${relative(REPO, f)}`).join('\n')}\n\n`);
const gh = ['release', 'create', tag, ...files, '--target', head, '--title', `Frame Studio ${version}`, '--generate-notes'];
if (!publish) {
  process.stdout.write(`To publish it:\n  gh ${gh.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : sh(a))).join(' ')}\nor run npm run desktop:release -- --publish.\n`);
  process.exit(0);
}
const published = spawnSync('gh', gh, { cwd: REPO, stdio: 'inherit' });
if (published.status !== 0) fail('gh release create failed. The files are still in build/desktop/dist/.');
process.stdout.write(`Published ${tag}. Installed apps find it within 4 hours, or at once from Check for Updates….\n`);
