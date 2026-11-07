/**
 * What a project folder can start by itself (ADR 0017): nothing. The agents in
 * the studio work only turns this server's routes took, so a thread written
 * into .frame-studio/ by someone else waits for a click, at the access the
 * click chooses. Runs real servers with the scripted test agent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { studioFolder } from '../../tools/studio/folder';
import { liveServer } from '../../tools/studio/connect';
import { newToken } from '../../tools/studio/pairing';
import { startStudioServer, type StudioServer } from '../../tools/studio/server';
import { StudioQueue } from '../../tools/studio/queue';

const SCENE = { id: 'shot', fps: 12, duration: 1, size: [64, 64], seed: 1, layers: [] };
const selection = { sceneId: 'shot', from: 0, to: 12 };

function planted(id: number, overrides: Record<string, unknown> = {}, turn: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-11-06T00:00:00.000Z',
    status: 'pending',
    agent: 'fake',
    sceneId: 'shot',
    turns: [{ ask: { prompt: 'wicked', references: [], selection, frame: 0, at: '2026-11-06T00:00:00.000Z' }, status: 'pending', settings: { access: 'full' }, ...turn }],
    ...overrides,
  };
}

const settle = () => new Promise((done) => setTimeout(done, 700));

describe('a turn found on disk', () => {
  let root: string;
  const servers: StudioServer[] = [];
  const before = process.env.FRAME_STUDIO_FAKE_AGENT;

  beforeAll(() => {
    process.env.FRAME_STUDIO_FAKE_AGENT = '1';
  });
  afterAll(() => {
    if (before === undefined) delete process.env.FRAME_STUDIO_FAKE_AGENT;
    else process.env.FRAME_STUDIO_FAKE_AGENT = before;
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    // A turn that was stopped by closing may still be writing its log.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function makeFolder(): void {
    root = mkdtempSync(join(tmpdir(), 'frame-studio-found-'));
    mkdirSync(join(root, 'scenes'));
    mkdirSync(join(root, '.frame-studio/requests'), { recursive: true });
    writeFileSync(join(root, 'scenes/shot.json'), JSON.stringify(SCENE));
    // Any step that runs leaves a mark: a write inside what studio access allows, and a command it has to ask about.
    writeFileSync(
      join(root, '.frame-studio/fake-agent.json'),
      JSON.stringify({
        scripts: [
          { match: 'wicked', steps: [{ write: { path: 'rigs/planted.ts', content: 'export const planted = 1;\n' } }, { command: `touch ${JSON.stringify(join(root, 'ran.txt'))}` }, { say: 'done' }] },
          { match: 'mine', steps: [{ say: 'yes' }] },
        ],
      }),
    );
  }

  async function start(options: { untrusted?: boolean } = {}): Promise<{ server: StudioServer; post(path: string, body?: unknown): Promise<Response>; get<T>(path: string): Promise<T> }> {
    const token = newToken();
    const server = await startStudioServer({
      folder: studioFolder(root, { studio: join(root, '.frame-studio'), ...(options.untrusted ? { untrusted: true } : {}) }),
      token,
      port: 0,
      viewer: { kind: 'static', dir: root },
      agents: true,
      thumbs: false,
      worker: 'app',
      log: () => {},
    });
    servers.push(server);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return {
      server,
      post: (path, body = {}) => fetch(`${server.url}/__studio${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      get: async <T,>(path: string) => (await (await fetch(`${server.url}/__studio${path}`, { headers })).json()) as T,
    };
  }

  const write = (name: string, value: unknown) => writeFileSync(join(root, '.frame-studio/requests', name), JSON.stringify(value));
  const read = (id: number) => JSON.parse(readFileSync(join(root, '.frame-studio/requests', `${String(id).padStart(4, '0')}.json`), 'utf8'));

  it('stays pending at boot, says so, and nothing it asked for happens', async () => {
    makeFolder();
    write('0001.json', planted(1));
    const { get } = await start();
    await settle();
    expect(read(1).status).toBe('pending');
    expect(existsSync(join(root, 'rigs/planted.ts'))).toBe(false);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
    const { requests } = await get<{ requests: { id: number; held?: boolean }[] }>('/queue');
    expect(requests.find((r) => r.id === 1)?.held).toBe(true);
  });

  it('stays pending when it appears while the server runs', async () => {
    makeFolder();
    await start();
    write('0002.json', planted(2));
    await settle();
    await settle();
    expect(read(2).status).toBe('pending');
    expect(existsSync(join(root, 'rigs/planted.ts'))).toBe(false);
  });

  it('runs a turn this server took, and shows it as nothing held', async () => {
    makeFolder();
    const { post, get } = await start();
    const res = await post('/requests', { selection, frame: 0, prompt: 'mine', references: [], agent: 'fake', settings: { access: 'studio' } });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(read(1).status).toBe('your_turn'), { timeout: 5000 });
    const { requests } = await get<{ requests: { held?: boolean }[] }>('/queue');
    expect(requests[0].held).toBeUndefined();
  });

  it('starts on a click at studio access, dropping what the file asked for', async () => {
    makeFolder();
    write('0001.json', planted(1, { session: 'someone-elses' }));
    const { post } = await start();
    await settle();
    expect((await post('/requests/1/start')).status).toBe(200);
    await vi.waitFor(() => expect(read(1).status).toBe('working'), { timeout: 5000 });
    const stored = read(1);
    expect(stored.turns[0].settings).toEqual({ access: 'studio' });
    expect(stored.session === undefined || stored.session !== 'someone-elses').toBe(true);
    // Studio access asks before a command, so the command in the file can't run with no card.
    await vi.waitFor(() => expect(read(1).turns[0].waitingSince).toBeDefined(), { timeout: 5000 });
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
    await post('/requests/1/stop');
    await vi.waitFor(() => expect(read(1).status).toBe('your_turn'), { timeout: 5000 });
  });

  it('honours the access the click chose, not the one in the file', async () => {
    makeFolder();
    write('0001.json', planted(1));
    const { post } = await start();
    await settle();
    await post('/requests/1/start', { settings: { access: 'full' } });
    await vi.waitFor(() => expect(read(1).status).toBe('your_turn'), { timeout: 5000 });
    expect(read(1).turns[0].settings).toEqual({ access: 'full' });
  });

  it('never carries stored access into a retry the viewer sent no settings for', async () => {
    makeFolder();
    write('0001.json', planted(1, { status: 'your_turn' }, { status: 'failed', settings: { access: 'full' } }));
    const { post } = await start();
    await post('/requests/1/retry', { prompt: 'mine' });
    await vi.waitFor(() => expect(read(1).status).toBe('your_turn'), { timeout: 5000 });
    expect(read(1).turns.at(-1).settings.access).toBe('studio');
  });

  it("leaves a requeued turn for a click, since nobody sent it", async () => {
    makeFolder();
    const { post, get } = await start();
    await post('/requests', { selection, frame: 0, prompt: 'mine', references: [], agent: 'fake', settings: { access: 'full' } });
    await vi.waitFor(() => expect(read(1).status).toBe('your_turn'), { timeout: 5000 });
    const stored = read(1);
    stored.turns[0].status = 'failed';
    write('0001.json', stored);
    await post('/requests/1/requeue');
    await settle();
    expect(read(1).status).toBe('pending');
    const { requests } = await get<{ requests: { held?: boolean }[] }>('/queue');
    expect(requests[0].held).toBe(true);
  });

  it('leaves external threads to external agents, as ever', async () => {
    makeFolder();
    write('0001.json', planted(1, { agent: 'external' }));
    const { server, get } = await start();
    await settle();
    const { requests } = await get<{ requests: { held?: boolean }[] }>('/queue');
    expect(requests[0].held).toBeUndefined();
    expect((await server.queue.claimNext('mcp-1'))?.id).toBe(1);
  });

  it('runs no thread at all in a folder opened without its code', async () => {
    makeFolder();
    write('0001.json', planted(1));
    const { post, get } = await start({ untrusted: true });
    await settle();
    expect(read(1).status).toBe('pending');
    const { agents, agentsOff } = await get<{ agents: { id: string }[]; agentsOff?: string }>('/agents');
    expect(agents.map((a) => a.id)).toEqual(['external']);
    expect(agentsOff).toMatch(/without its code/);
    expect((await post('/requests/1/start')).status).toBe(409);
    expect((await post('/requests', { selection, frame: 0, prompt: 'mine', references: [], agent: 'fake', settings: { access: 'studio' } })).status).toBe(409);
    await settle();
    expect(existsSync(join(root, 'rigs/planted.ts'))).toBe(false);
  });

  it('skips a thread whose id is not its file name, so a planted id reaches no other path', async () => {
    makeFolder();
    const claimedBy = 'studio-999999-gone';
    write('0003.json', planted(3, { id: '../../scenes/evil', status: 'working' }, { status: 'working', claimedBy }));
    write('0004.json', planted(4, { id: 7 }));
    const { get } = await start();
    await settle();
    const { requests } = await get<{ requests: unknown[] }>('/queue');
    expect(requests).toEqual([]);
    expect(existsSync(join(root, 'scenes/evil.json'))).toBe(false);
  });
});

describe('a server.json found on disk', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('names only this computer', async () => {
    root = mkdtempSync(join(tmpdir(), 'frame-studio-found-'));
    mkdirSync(join(root, '.frame-studio'));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    writeFileSync(join(root, '.frame-studio/server.json'), JSON.stringify({ url: 'https://example.com', token: 'x'.repeat(24) }));
    const folder = studioFolder(root, { studio: join(root, '.frame-studio') });
    expect(await liveServer(folder)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});

describe('the queue', () => {
  it('keeps a thread whose id matches its file, and only that', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frame-studio-found-'));
    try {
      mkdirSync(join(dir, 'requests'));
      writeFileSync(join(dir, 'requests/0001.json'), JSON.stringify(planted(1)));
      writeFileSync(join(dir, 'requests/0002.json'), JSON.stringify(planted(9)));
      writeFileSync(join(dir, 'requests/0003.json'), JSON.stringify({ id: 3, turns: [] }));
      const queue = new StudioQueue(dir, async () => '');
      expect((await queue.list()).map((r) => r.id)).toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

