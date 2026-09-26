/**
 * The studio server's pieces (ADR 0008), against temporary folders: pairing,
 * the module service that hands rigs to pages, and how it names, rewrites and
 * refuses modules.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { studioFolder, type StudioFolder } from '../../tools/studio/folder';
import { findSource } from '../../tools/studio/loader';
import { ModuleService } from '../../tools/studio/modules';
import { COOKIE, newToken, Pairing } from '../../tools/studio/pairing';
import { RenderPool } from '../../tools/studio/render-pool';

describe('pairing', () => {
  const token = newToken();
  const pairing = new Pairing(token);
  const req = (headers: Record<string, string>) => ({ headers }) as never;

  it('takes the token as a bearer token, or the cookie the page got for it', () => {
    expect(pairing.allows(req({ authorization: `Bearer ${token}` }))).toBe(true);
    expect(pairing.allows(req({ authorization: `Bearer ${newToken()}` }))).toBe(false);
    expect(pairing.allows(req({}))).toBe(false);
    const res = { headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name] = value; } };
    pairing.setCookie(res as never);
    const cookie = res.headers['Set-Cookie'];
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=[\\w-]+; HttpOnly; SameSite=Strict; Path=/$`));
    // A malformed cookie from another app on the same host is skipped.
    expect(pairing.allows(req({ cookie: `other=50%; ${cookie.split(';')[0]}` }))).toBe(true);
    const value = cookie.split(';')[0];
    expect(pairing.allows(req({ cookie: `other=1; ${value}` }))).toBe(true);
    // The same token gives the same cookie, so a restarted server keeps its pages paired.
    expect(new Pairing(token).allows(req({ cookie: value }))).toBe(true);
    expect(new Pairing(newToken()).allows(req({ cookie: value }))).toBe(false);
    // Named after the port once the server listens, so two servers keep their own cookies.
    const ported = new Pairing(token);
    ported.setPort(4753);
    expect(ported.cookieName).toBe(`${COOKIE}_4753`);
    expect(ported.allows(req({ cookie: value }))).toBe(false);
  });

  it('refuses a short token', () => {
    expect(() => new Pairing('short')).toThrow(/16 characters/);
  });
});

describe('the module service', () => {
  let root: string;
  let folder: StudioFolder;
  let service: ModuleService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'frame-studio-modules-'));
    mkdirSync(join(root, 'builtins/rigs/parts'), { recursive: true });
    mkdirSync(join(root, 'builtins/audio'), { recursive: true });
    mkdirSync(join(root, 'builtins/viewer'), { recursive: true });
    mkdirSync(join(root, 'folder/rigs'), { recursive: true });
    mkdirSync(join(root, 'folder/projects/story/rigs'), { recursive: true });
    writeFileSync(join(root, 'builtins/rigs/parts/params.ts'), 'export const num = (d: number): number => d;\n');
    writeFileSync(join(root, 'builtins/rigs/index.ts'), "import { num } from './parts/params';\nexport const allRigs: unknown[] = [num(1)];\n");
    writeFileSync(join(root, 'builtins/audio/index.ts'), 'export const allGenerators: unknown[] = [];\n');
    writeFileSync(join(root, 'builtins/viewer/app.ts'), 'export const secret = 1;\n');
    writeFileSync(join(root, 'folder/rigs/hat.ts'), "import type { Rig } from '@frame-studio/engine/types';\nimport { num } from '@frame-studio/rigs/parts/params';\nexport const hat = { id: 'hat', size: num(3) as number };\n");
    writeFileSync(join(root, 'folder/projects/story/rigs/iris.ts'), "export { hat } from '../../../rigs/hat';\n");
    folder = studioFolder(join(root, 'folder'), { builtins: join(root, 'builtins') });
    service = new ModuleService(folder);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Serves a module URL and returns its body and status. */
  async function get(url: string): Promise<{ status: number; body: string; cache: string }> {
    const [path, query] = url.slice('/__studio/m/'.length).split('?');
    const out = { status: 0, body: '', cache: '', headers: {} as Record<string, string> };
    const res = {
      set statusCode(n: number) {
        out.status = n;
      },
      setHeader(name: string, value: string) {
        out.headers[name.toLowerCase()] = value;
      },
      end(text: string) {
        out.body = text;
      },
    } as unknown as ServerResponse;
    await service.serve(path, new URLSearchParams(query ?? '').get('h'), res);
    return { status: out.status, body: out.body, cache: out.headers['cache-control'] ?? '' };
  }

  it('lists the entry modules, and serves JavaScript with every import pointing back at the service', async () => {
    const manifest = await service.manifest();
    expect(manifest.builtinRigs).toMatch(/^\/__studio\/m\/b\/rigs\/index\.ts\?h=[0-9a-f]{16}$/);
    expect(manifest.folderRigs).toEqual([expect.stringMatching(/^\/__studio\/m\/f\/rigs\/hat\.ts\?h=/)]);
    expect(Object.keys(manifest.projectRigs)).toEqual(['story']);
    const hat = await get(manifest.folderRigs[0]);
    expect(hat.status).toBe(200);
    expect(hat.cache).toMatch(/immutable/);
    // Types gone, @frame-studio/ and relative imports rewritten to hashed URLs.
    expect(hat.body).not.toMatch(/: number|import type/);
    expect(hat.body).toMatch(/from '\/__studio\/m\/b\/rigs\/parts\/params\.ts\?h=[0-9a-f]{16}'/);
    const iris = await get(manifest.projectRigs.story[0]);
    expect(iris.body).toMatch(/from '\/__studio\/m\/f\/rigs\/hat\.ts\?h=[0-9a-f]{16}'/);
  });

  it("changes the URLs of an edited file and its importers only", async () => {
    const before = await service.manifest();
    writeFileSync(join(root, 'builtins/rigs/parts/params.ts'), 'export const num = (d: number): number => d * 2;\n');
    service.invalidate();
    const after = await service.manifest();
    expect(after.builtinRigs).not.toBe(before.builtinRigs);
    expect(after.folderRigs[0]).not.toBe(before.folderRigs[0]);
    expect(after.builtinAudio).toBe(before.builtinAudio);
  });

  it('hashes files that import each other as one, so an edit to any of them reaches all', async () => {
    writeFileSync(join(root, 'folder/rigs/a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
    writeFileSync(join(root, 'folder/rigs/b.ts'), "import { c } from './c';\nexport const b = () => c;\n");
    writeFileSync(join(root, 'folder/rigs/c.ts'), "import { a } from './a';\nexport const c = () => a;\n");
    const url = (m: { folderRigs: string[] }, name: string) => m.folderRigs.find((u) => u.includes(`/rigs/${name}.ts`))!;
    const before = await service.manifest();
    writeFileSync(join(root, 'folder/rigs/b.ts'), "import { c } from './c';\nexport const b = () => [c];\n");
    service.invalidate();
    const after = await service.manifest();
    for (const name of ['a', 'b', 'c']) expect(url(after, name), name).not.toBe(url(before, name));
    expect(url(after, 'hat')).toBe(url(before, 'hat'));
  });

  it('lists a file that will not strip, and serves it as a module that throws why', async () => {
    writeFileSync(join(root, 'folder/rigs/enum.ts'), 'export enum Kind { A }\n');
    const manifest = await service.manifest();
    const url = manifest.folderRigs.find((u) => u.includes('/rigs/enum.ts'))!;
    expect((await get(url)).body).toMatch(/throw new Error\(".*rigs\/enum\.ts: .*enum/);
  });

  it('answers a module it cannot serve with one that throws the reason, and never serves outside the rigs and engine', async () => {
    writeFileSync(join(root, 'folder/rigs/broken.ts'), "import { nothing } from './missing';\nexport const x = nothing;\n");
    writeFileSync(join(root, 'folder/rigs/package.ts'), "import { z } from 'zod';\nexport const y = z;\n");
    const broken = await get('/__studio/m/f/rigs/broken.ts');
    expect(broken.body).toMatch(/throw new Error\(".*rigs\/broken\.ts: imports \\".\/missing\\", and there is no such file"\)/);
    expect(broken.cache).toBe('no-store');
    expect((await get('/__studio/m/f/rigs/package.ts')).body).toMatch(/rigs and generators take no packages/);
    expect((await get('/__studio/m/b/viewer/app.ts')).status).toBe(404);
    expect((await get('/__studio/m/f/rigs/../scenes/x.ts')).status).toBe(404);
    expect((await get('/__studio/m/x/rigs/hat.ts')).status).toBe(404);
  });

  it('finds a module the way the bundler does: the path, then .ts, then index.ts', () => {
    expect(findSource(join(root, 'builtins/rigs/parts/params'))).toBe(join(root, 'builtins/rigs/parts/params.ts'));
    expect(findSource(join(root, 'builtins/rigs'))).toBe(join(root, 'builtins/rigs/index.ts'));
    expect(findSource(join(root, 'builtins/nothing'))).toBeNull();
  });
});

describe('the render pool', () => {
  const fakeRes = () => {
    const written: string[] = [];
    const res = Object.assign(new EventEmitter(), { written, setHeader() {}, flushHeaders() {}, write: (t: string) => written.push(t), end() {} });
    return res as unknown as ServerResponse & { written: string[] };
  };
  const jobsIn = (res: { written: string[] }) =>
    res.written.filter((w) => w.startsWith('event: job')).map((w) => JSON.parse(w.split('data: ')[1]) as { id: string; method: string });

  it('sends a job again to the next worker when its worker goes away, and starts a new worker if the old one ended', async () => {
    let launches = 0;
    const exits: (() => void)[] = [];
    const pool = new RenderPool(async () => {
      launches++;
      let done!: () => void;
      const exited = new Promise<void>((resolve) => (done = resolve));
      exits.push(done);
      return { exited, close: async () => done() };
    });
    const answer = pool.call('s', 'renderFrame', [1]);
    await new Promise((r) => setTimeout(r, 5));
    const first = new EventEmitter();
    const res1 = fakeRes();
    pool.attach(first as never, res1);
    const [job] = jobsIn(res1);
    // The page crashes and its Electron ends.
    first.emit('close');
    exits[0]();
    await new Promise((r) => setTimeout(r, 5));
    expect(launches).toBe(2);
    const res2 = fakeRes();
    pool.attach(new EventEmitter() as never, res2);
    expect(jobsIn(res2).map((j) => j.id)).toEqual([job.id]);
    pool.result(job.id, { ok: true, value: 42 });
    expect(await answer).toBe(42);
    await pool.close();
  });

  it('gives up on a job that takes down three workers, and goes on with the next', async () => {
    const pool = new RenderPool(null);
    const stuck = pool.call('s', 'renderFrame', [1]);
    const next = pool.call('s', 'renderFrame', [2]);
    let last = fakeRes();
    for (let i = 0; i < 3; i++) {
      const req = new EventEmitter();
      last = fakeRes();
      pool.attach(req as never, last);
      if (i < 2) req.emit('close');
    }
    // The third worker is still up; a fourth attach would be the fourth try.
    const req = new EventEmitter();
    (pool as unknown as { worker: unknown }).worker = null;
    last = fakeRes();
    pool.attach(req as never, last);
    await expect(stuck).rejects.toThrow(/stopped while working on this 3 times/);
    const [job] = jobsIn(last);
    expect(job.method).toBe('renderFrame');
    pool.result(job.id, { ok: true, value: 'two' });
    expect(await next).toBe('two');
    await pool.close();
  });

  it('cancels at once when no worker is there, or before a job starts', async () => {
    const pool = new RenderPool(null);
    await expect(pool.call('s', 'x', [], { signal: AbortSignal.abort() })).rejects.toThrow(/Cancelled/);
    const abort = new AbortController();
    const waiting = pool.call('s', 'exportVideo', [], { signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow(/Cancelled/);
    await pool.close();
  });
});
