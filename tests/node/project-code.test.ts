/**
 * Which of a project's files are code, and what that code may reach (ADR 0017):
 * trust and the loaders decide by one shared function, so what the hash covers
 * and what can run never drift apart. Node's own loader only runs outside
 * Vitest's sandbox, so those cases run in a child process.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEmbed } from '../../tools/bundle/embed';
import { CodeHost } from '../../tools/studio/code';
import { connectStudio } from '../../tools/studio/connect';
import { REPO, studioFolder, trustsCode } from '../../tools/studio/folder';
import { ModuleService } from '../../tools/studio/modules';
import { newToken } from '../../tools/studio/pairing';
import { checkApproval, dialogName, projectCode } from '../../tools/studio/project-code';
import { startStudioServer } from '../../tools/studio/server';


const plainRig = (id: string, extra = '') => `${extra}\nexport const ${id} = { id: ${JSON.stringify(id)}, params: {}, draw() {} };\n`;
/** Code that leaves a mark when it runs. */
const marks = (path: string) => `(globalThis as { process?: { getBuiltinModule(n: string): { writeFileSync(p: string, s: string): void } } }).process?.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(path)}, 'ran');\nexport const lib = 1;\n`;

let dir: string;
let root: string;

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-code-')));
  root = join(dir, 'project');
  mkdirSync(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Loads `root` with Node's real loader, in a process of its own. */
function loadInNode(target = root): { rigs: string[]; errors: string[] } {
  const script = `
    import { installLoader } from ${JSON.stringify(join(REPO, 'tools/studio/loader.ts'))};
    installLoader(${JSON.stringify(join(REPO, 'src'))});
    const { CodeHost } = await import(${JSON.stringify(join(REPO, 'tools/studio/code.ts'))});
    const { studioFolder } = await import(${JSON.stringify(join(REPO, 'tools/studio/folder.ts'))});
    const loaded = await new CodeHost(studioFolder(${JSON.stringify(target)})).load();
    console.log(JSON.stringify({ rigs: [...loaded.folderRigs, ...Object.values(loaded.projectRigs).flat()].map((r) => r.id).sort(), errors: loaded.errors }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  expect(run.stderr.replace(/.*ExperimentalWarning.*\n?|.*node --trace-warnings.*\n?/g, '')).toBe('');
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { rigs: string[]; errors: string[] };
}

describe('which files are code', () => {
  it('asks about a folder holding only a dot file', () => {
    put('rigs/.sneaky.ts', 'export const x = 1;\n');
    expect(projectCode(root).files).toBe(1);
  });

  it('counts every file type a rig can import, and old films', () => {
    put('rigs/a.js', '');
    put('audio/b.mjs', '');
    put('rigs/c.json', '{}');
    put('projects/film/rigs/d.ts', '');
    put('rigs/notes.md', '');
    expect(projectCode(root).files).toBe(4);
  });

  it('hashes dot folders, so what they hold changing asks again', () => {
    put('rigs/a.ts', "import './.lib/b';\n");
    put('rigs/.lib/b.ts', 'one');
    const first = projectCode(root).hash;
    put('rigs/.lib/b.ts', 'two');
    expect(projectCode(root).hash).not.toBe(first);
  });

  it("isn't moved by the file Finder drops in a folder", () => {
    put('rigs/a.ts', 'one');
    const first = projectCode(root).hash;
    put('rigs/.DS_Store', 'finder');
    expect(projectCode(root).hash).toBe(first);
  });

  it('never reads through a link, and a linked folder holds no code', () => {
    put('rigs/a.ts', 'one');
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside/secret.ts'), 'one');
    symlinkSync(join(dir, 'outside'), join(root, 'rigs/linked'));
    const first = projectCode(root).hash;
    writeFileSync(join(dir, 'outside/secret.ts'), 'two');
    expect(projectCode(root).hash).toBe(first);
  });
});

describe('what a project may import', () => {
  it('refuses a file outside rigs/ and audio/, and says which', () => {
    put('rigs/a.ts', plainRig('a', "import '../lib/b';"));
    put('lib/b.ts', marks(join(root, 'ran.txt')));
    const { rigs, errors } = loadInNode();
    expect(rigs).toEqual([]);
    expect(errors.join('\n')).toMatch(/rigs\/a\.ts.*lib\/b/);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('allows rigs/, audio/ and the built-ins', () => {
    put('rigs/a.ts', plainRig('a', "import { helper } from '../audio/helper';\nimport { num } from '@frame-studio/rigs/parts/params';\nvoid helper; void num;"));
    put('audio/helper.ts', 'export const helper = 1;\n');
    expect(loadInNode()).toEqual({ rigs: ['a'], errors: [] });
  });

  it("keeps a film's rigs to that film", () => {
    put('projects/one/rigs/a.ts', plainRig('a', "import { b } from '../../two/rigs/b';\nvoid b;"));
    put('projects/two/rigs/b.ts', 'export const b = 1;\n');
    expect(loadInNode().errors.join('\n')).toMatch(/projects\/one\/rigs\/a\.ts.*two\/rigs\/b/);
  });

  it('refuses an @frame-studio/ name with no built-in, which Node would look for in node_modules', () => {
    put('rigs/a.ts', plainRig('a', "import '@frame-studio/nothing';"));
    put('node_modules/@frame-studio/nothing/index.ts', marks(join(root, 'ran.txt')));
    expect(loadInNode().errors.join('\n')).toMatch(/not a built-in/);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('hashes a folder named .DS_Store, and skips only the file', () => {
    put('rigs/a.ts', plainRig('a'));
    const before = projectCode(root).hash;
    put('rigs/.DS_Store', 'junk');
    expect(projectCode(root).hash).toBe(before);
    rmSync(join(root, 'rigs/.DS_Store'));
    put('rigs/.DS_Store/evil.ts', 'export {};');
    expect(projectCode(root).hash).not.toBe(before);
  });

  it('refuses code that no longer matches its approval, and keeps no approval to skip', () => {
    put('rigs/a.ts', plainRig('a'));
    let refused = false;
    const folder = { root, approval: { hash: 'not this', refused: () => (refused = true) } } as { root: string; untrusted?: boolean; approval?: { hash: string; refused(): void } };
    checkApproval(folder);
    expect(refused).toBe(true);
    expect(folder.untrusted).toBe(true);
    expect(folder.approval).toBeUndefined();
  });

  it('refuses a link into node_modules, whose target the hash never sees', () => {
    put('rigs/node_modules/x.ts', marks(join(root, 'ran.txt')));
    put('rigs/a.ts', plainRig('a', "import './link';"));
    symlinkSync(join(root, 'rigs/node_modules/x.ts'), join(root, 'rigs/link.ts'));
    expect(loadInNode().errors.join('\n')).toMatch(/link into node_modules/);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('cleans a folder name for a dialog', () => {
    expect(dialogName('/x/Sample\nhas 0 source files')).toBe('Sample has 0 source files');
    expect(dialogName(`/x/${'a'.repeat(80)}`)).toHaveLength(60);
  });

  it('refuses node_modules and packages', () => {
    put('rigs/a.ts', plainRig('a', "import './node_modules/x/index';"));
    put('rigs/node_modules/x/index.ts', marks(join(root, 'ran.txt')));
    put('rigs/b.ts', plainRig('b', "import 'node:fs';"));
    put('rigs/c.ts', plainRig('c', "import 'left-pad';"));
    const { rigs, errors } = loadInNode();
    expect(rigs).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses a way out through the built-ins name, or a file URL', () => {
    put('secret.ts', marks(join(root, 'ran.txt')));
    put('rigs/a.ts', plainRig('a', `import ${JSON.stringify(`@frame-studio/../${'../'.repeat(12)}${root.slice(1)}/secret`)};`));
    put('rigs/b.ts', plainRig('b', `import ${JSON.stringify(`file://${root}/secret.ts`)};`));
    const { errors } = loadInNode();
    expect(errors).toHaveLength(2);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses a link that leaves, as a file or a folder, and keeps one that stays', () => {
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside/b.ts'), marks(join(root, 'ran.txt')));
    put('rigs/keep.ts', plainRig('keep', "import './near';"));
    put('audio/real.ts', 'export const near = 1;\n');
    symlinkSync(join(root, 'audio/real.ts'), join(root, 'rigs/near.ts'));
    symlinkSync(join(dir, 'outside/b.ts'), join(root, 'rigs/leaves.ts'));
    mkdirSync(join(root, 'rigs/deep'));
    symlinkSync(join(dir, 'outside'), join(root, 'rigs/deep/out'));
    put('rigs/through.ts', plainRig('through', "import './deep/out/b';"));
    const { rigs, errors } = loadInNode();
    expect(rigs).toEqual(['keep']);
    expect(errors.join('\n')).toMatch(/leaves\.ts/);
    expect(errors.join('\n')).toMatch(/through\.ts/);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses the same to pages', async () => {
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside/b.ts'), 'export const stolen = "secret words";\n');
    put('rigs/out.ts', plainRig('out', "import '../lib/b';"));
    put('lib/b.ts', '');
    put('rigs/mods.ts', plainRig('mods', "import './node_modules/x/index';"));
    put('rigs/node_modules/x/index.ts', '');
    symlinkSync(join(dir, 'outside/b.ts'), join(root, 'rigs/leaves.ts'));
    put('projects/one/rigs/a.ts', plainRig('a', "import '../../two/rigs/b';"));
    put('projects/two/rigs/b.ts', '');
    const service = new ModuleService(studioFolder(root));
    const serve = async (path: string) => {
      let text = '';
      const res = Object.assign(new EventEmitter(), { statusCode: 0, setHeader() {}, end: (t: string) => (text = t) }) as unknown as ServerResponse;
      await service.serve(path, null, res);
      return text;
    };
    await expect(serve('f/rigs/out.ts')).resolves.toMatch(/throw new Error.*lib\/b/);
    await expect(serve('f/rigs/mods.ts')).resolves.toMatch(/throw new Error.*node_modules/);
    await expect(serve('f/projects/one/rigs/a.ts')).resolves.toMatch(/throw new Error.*two\/rigs\/b/);
    const leaves = await serve('f/rigs/leaves.ts');
    expect(leaves).toMatch(/throw new Error/);
    expect(leaves).not.toContain('secret words');
  });
});

describe('what an export may carry', () => {
  it("refuses an import() that a rig never ran at load, so it can't carry a file out", async () => {
    put('secret.ts', 'export const secret = "secret words";\n');
    put('rigs/a.ts', plainRig('a', "export const later = () => import('../secret');"));
    put('scenes/s.json', JSON.stringify({ id: 's', fps: 12, duration: 1, size: [64, 64], seed: 1, layers: [{ id: 'one', rig: 'a' }] }));
    const folder = studioFolder(root);
    await expect(buildEmbed('s', { folder, code: new CodeHost(folder) })).rejects.toThrow(/rigs\/a\.ts imports "\.\.\/secret"/);
  });
});

describe('between asking and loading', () => {
  it('loads what was approved', async () => {
    put('rigs/a.ts', plainRig('a'));
    let refused = 0;
    const folder = studioFolder(root, { approval: { hash: projectCode(root).hash, refused: () => refused++ } });
    expect((await new CodeHost(folder).load()).folderRigs.map((r) => r.id)).toEqual(['a']);
    expect(refused).toBe(0);
  });

  it("refuses code that changed, and tells whoever asked", async () => {
    put('rigs/a.ts', plainRig('a'));
    let refused = 0;
    const folder = studioFolder(root, { approval: { hash: projectCode(root).hash, refused: () => refused++ } });
    put('rigs/a.ts', plainRig('a', '// not what you saw'));
    const loaded = await new CodeHost(folder).load();
    expect(loaded.folderRigs).toEqual([]);
    expect(refused).toBe(1);
    expect(folder.untrusted).toBe(true);
    const manifest = await new ModuleService(folder).manifest();
    expect(manifest.folderRigs).toEqual([]);
  });

  it('checks for pages too, when they ask first', async () => {
    put('rigs/a.ts', plainRig('a'));
    let refused = 0;
    const folder = studioFolder(root, { approval: { hash: 'other', refused: () => refused++ } });
    expect((await new ModuleService(folder).manifest()).folderRigs).toEqual([]);
    expect(refused).toBe(1);
  });

  it('holds only for the first load: what changes while open stays trusted', async () => {
    put('rigs/a.ts', plainRig('a'));
    const folder = studioFolder(root, { approval: { hash: projectCode(root).hash, refused: () => expect.unreachable() } });
    const code = new CodeHost(folder);
    await code.load();
    put('rigs/b.ts', plainRig('b'));
    code.invalidate();
    expect((await code.load()).folderRigs.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(folder.untrusted).toBeUndefined();
  });
});

describe('a server the app did not start', () => {
  function bin(args: string[], env: Record<string, string> = {}): Promise<{ url: string; stop(): void }> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [join(REPO, 'tools/studio/bin.ts'), '--folder', root, '--viewer', root, '--port', '0', ...args], { env: { ...process.env, FRAME_STUDIO_TRUST: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.write(`${'t'.repeat(32)}\n`);
      child.stdout.setEncoding('utf8').once('data', (text: string) => done({ url: text.trim(), stop: () => child.kill() }));
      child.once('exit', (code) => fail(new Error(`bin stopped with ${code}`)));
    });
  }
  const headers = { Authorization: `Bearer ${'t'.repeat(32)}` };
  const folderRigs = async (url: string) => ((await (await fetch(`${url}/__studio/modules`, { headers })).json()) as { modules: { folderRigs: string[] } }).modules.folderRigs;

  it('loads built-ins only by default', async () => {
    put('rigs/a.ts', plainRig('a'));
    const server = await bin([]);
    try {
      expect(await folderRigs(server.url)).toEqual([]);
    } finally {
      server.stop();
    }
  }, 30_000);

  it('loads a project with --trust', async () => {
    put('rigs/a.ts', plainRig('a'));
    const server = await bin(['--trust']);
    try {
      expect(await folderRigs(server.url)).toHaveLength(1);
    } finally {
      server.stop();
    }
  }, 30_000);

  it('loads a project with FRAME_STUDIO_TRUST=1, and --untrusted beats it', async () => {
    put('rigs/a.ts', plainRig('a'));
    const server = await bin([], { FRAME_STUDIO_TRUST: '1' });
    try {
      expect(await folderRigs(server.url)).toHaveLength(1);
    } finally {
      server.stop();
    }
    const refused = await bin(['--untrusted'], { FRAME_STUDIO_TRUST: '1' });
    try {
      expect(await folderRigs(refused.url)).toEqual([]);
    } finally {
      refused.stop();
    }
  }, 30_000);

  it('counts the repo as trusted', () => {
    expect(trustsCode(REPO)).toBe(true);
    expect(trustsCode(resolve(REPO, '.'))).toBe(true);
    expect(trustsCode(root)).toBe(false);
    expect(trustsCode(root, true)).toBe(true);
    const was = process.env.FRAME_STUDIO_TRUST;
    process.env.FRAME_STUDIO_TRUST = '1';
    expect(trustsCode(root)).toBe(true);
    if (was === undefined) delete process.env.FRAME_STUDIO_TRUST;
    else process.env.FRAME_STUDIO_TRUST = was;
  });

  it('finds a running server across a link to its folder', async () => {
    const token = newToken();
    const live = await startStudioServer({ folder: studioFolder(root), token, port: 0, viewer: { kind: 'static', dir: root }, thumbs: false, worker: 'app', discovery: true, log: () => {} });
    try {
      symlinkSync(root, join(dir, 'linked'));
      const reusing = await connectStudio(studioFolder(join(dir, 'linked'), { untrusted: true }), { viewer: { kind: 'static', dir: root } });
      expect(reusing.url).toBe(live.url);
      await reusing.close();
    } finally {
      await live.close();
    }
  });

  it('never hands code a running untrusted server to a tool told to trust it', async () => {
    put('rigs/a.ts', plainRig('a'));
    const token = newToken();
    const live = await startStudioServer({ folder: studioFolder(root, { untrusted: true }), token, port: 0, viewer: { kind: 'static', dir: root }, thumbs: false, worker: 'app', discovery: true, log: () => {} });
    try {
      const reusing = await connectStudio(studioFolder(root, { untrusted: true }), { viewer: { kind: 'static', dir: root } });
      expect(reusing.url).toBe(live.url);
      expect(reusing.untrusted).toBe(true);
      await reusing.close();
      const own = await connectStudio(studioFolder(root), { viewer: { kind: 'static', dir: root } });
      expect(own.url).not.toBe(live.url);
      expect(own.untrusted).toBe(false);
      await own.close();
    } finally {
      await live.close();
    }
  });
});
