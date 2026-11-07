/**
 * Generate Voice's Node side (ADR 0017): the ElevenLabs provider, the pinned
 * fetch a key travels through, the key store, naming files in media/, Kokoro's
 * pinned download, and a project's code left unloaded without trust. The app's
 * own paths, with a fake provider host, are in tests/browser/speech.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyStore, type KeyCipher } from '../../desktop/keys';
import { projectCode } from '../../desktop/trust';
import { CodeHost, withheldCode } from '../../tools/studio/code';
import { studioFolder } from '../../tools/studio/folder';
import { ModuleService } from '../../tools/studio/modules';
import { Kokoro, KOKORO_VOICES, kokoroManifest, type KokoroManifest } from '../../tools/voice/kokoro';
import { isLoopback, pinnedFetch } from '../../tools/voice/pinned';
import { elevenlabs, wordsFromAlignment } from '../../tools/voice/providers/elevenlabs';
import { saveVoiceFile } from '../../tools/voice/save';
import { estimate, finished, ProviderError, type Generated, type Pending } from '../../tools/voice/types';

const dir = mkdtempSync(join(tmpdir(), 'frame-studio-voice-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY = 'sk_test_0123456789abcdef_WXYZ';

describe('the ElevenLabs provider', () => {
  const request = { kind: 'voice' as const, text: '¿Por qué?', lang: 'es', voice: 'pNInz6obpgDQGcFmaJgB' };

  it('asks its with-timestamps endpoint, and turns characters into words', async () => {
    const calls: { path: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    const made = (await elevenlabs.generate(request, KEY, async (path, init) => {
      calls.push({ path, init });
      return Response.json({
        audio_base64: Buffer.from('mp3 bytes').toString('base64'),
        alignment: { characters: [...'¿Por qué?'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] },
      });
    })) as Generated;
    expect(calls[0].path).toBe('/v1/text-to-speech/pNInz6obpgDQGcFmaJgB/with-timestamps?output_format=mp3_44100_128');
    expect(calls[0].init.headers['xi-api-key']).toBe(KEY);
    expect(JSON.parse(calls[0].init.body!)).toEqual({ text: '¿Por qué?', model_id: 'eleven_multilingual_v2', language_code: 'es' });
    expect(Buffer.from(made.bytes).toString()).toBe('mp3 bytes');
    expect(made.ext).toBe('.mp3');
    expect(made.words).toEqual([
      { text: '¿Por', start: 0, end: 0.4 },
      { text: 'qué?', start: 0.5, end: 0.9 },
    ]);
  });

  it('reports a failure by status alone, leaving the body out', async () => {
    const failed = elevenlabs.generate(request, KEY, async () => new Response(`bad key ${KEY}`, { status: 401 }));
    await expect(failed).rejects.toBeInstanceOf(ProviderError);
    await expect(failed).rejects.not.toThrow(KEY);
    await expect(failed).rejects.toThrow('ElevenLabs refused the key (401).');
  });

  it('copes with no timing', () => {
    expect(wordsFromAlignment({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([]);
  });

  it('offers English and Spanish voices', () => {
    for (const lang of ['en', 'es']) expect(elevenlabs.voices.some((v) => v.langs.includes(lang))).toBe(true);
    expect(elevenlabs.kinds).toContain('voice');
    expect(estimate(elevenlabs, 'x'.repeat(1000))).toBe('about $0.10');
    expect(estimate(elevenlabs, 'x')).toBe('under $0.01');
  });
});

describe('the fetch a key goes through', () => {
  it('reaches its own origin, and never follows a redirect', async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const http = pinnedFetch('https://api.example.test', (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.href, redirect: init.redirect });
      return new Response('ok');
    }) as unknown as typeof fetch);
    await http('/v1/speak?x=1', { method: 'POST', headers: {} });
    expect(seen).toEqual([{ url: 'https://api.example.test/v1/speak?x=1', redirect: 'error' }]);
  });

  it('refuses any other host, however the path is written', () => {
    const http = pinnedFetch('https://api.example.test', (async () => new Response('no')) as unknown as typeof fetch);
    for (const path of ['https://evil.test/steal', '//evil.test/steal', 'http://api.example.test/plain']) {
      expect(() => http(path, { method: 'GET', headers: {} })).toThrow(/outside its pinned/);
    }
  });

  it('takes only a loopback address as a test host', () => {
    expect(isLoopback('http://127.0.0.1:4000')).toBe(true);
    expect(isLoopback('https://evil.test')).toBe(false);
    expect(isLoopback('http://127.0.0.1.evil.test:80')).toBe(false);
  });

  it('waits out a job that takes a while, for Generate Video later', async () => {
    const done: Generated = { bytes: new Uint8Array([1]), ext: '.mp4' };
    let polls = 0;
    const job = (): Pending => ({ pending: true, after: 5, poll: async () => (++polls < 2 ? job() : done) });
    expect(await finished(job(), async () => {})).toBe(done);
    expect(polls).toBe(2);
  });
});

/** A stand-in for safeStorage: reversible, and never the plain text. */
const cipher = (over: Partial<KeyCipher> = {}): KeyCipher => ({
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain).map((b) => b ^ 0x5a) as Buffer,
  decryptString: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString(),
  ...over,
});

describe('the key store', () => {
  it('keeps ciphertext only, readable by you alone, and hands back only the last four', async () => {
    const file = join(dir, 'store-1/keys.json');
    const store = new KeyStore(file, cipher());
    await store.save('elevenlabs', `  ${KEY}\n`);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [listed] = await store.list();
    expect(listed).toEqual({ provider: 'elevenlabs', last4: 'WXYZ', added: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(JSON.stringify(await store.list())).not.toContain(KEY);
    expect(await store.reveal('elevenlabs')).toBe(KEY);
  });

  it('forgets a removed key', async () => {
    const file = join(dir, 'store-2/keys.json');
    const store = new KeyStore(file, cipher());
    await store.save('elevenlabs', KEY);
    await store.remove('elevenlabs');
    expect(await store.list()).toEqual([]);
    expect(await store.reveal('elevenlabs')).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain('WXYZ');
  });

  it('refuses when the system offers no real encryption', async () => {
    const off = new KeyStore(join(dir, 'store-3/keys.json'), cipher({ isEncryptionAvailable: () => false }));
    expect(off.refusal()).toMatch(/no secure storage/);
    await expect(off.save('elevenlabs', KEY)).rejects.toThrow(/no secure storage/);
    expect(existsSync(join(dir, 'store-3/keys.json'))).toBe(false);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(new KeyStore(join(dir, 'x'), cipher({ getSelectedStorageBackend: () => 'basic_text' })).refusal()).toMatch(/plain text/);
      expect(new KeyStore(join(dir, 'x'), cipher({ getSelectedStorageBackend: () => 'gnome_libsecret' })).refusal()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('refuses something that is no key', async () => {
    const store = new KeyStore(join(dir, 'store-4/keys.json'), cipher());
    for (const bad of ['short', 'has a space in it', 'x'.repeat(600), '']) await expect(store.save('elevenlabs', bad)).rejects.toThrow(/look like an API key/);
  });
});

describe('saving a generated file', () => {
  it('picks the name itself and never overwrites', async () => {
    const root = join(dir, 'save-1');
    mkdirSync(root);
    const one = await saveVoiceFile(root, 'kokoro', '.wav', new Uint8Array([1]));
    const two = await saveVoiceFile(root, 'kokoro', '.wav', new Uint8Array([2]));
    expect(one).toMatch(/^media\/voice-kokoro-\d{8}-\d{6}\.wav$/);
    expect(two).not.toBe(one);
    expect(readFileSync(join(root, one))[0]).toBe(1);
    expect(readdirSync(join(root, 'media')).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it("refuses a media folder that leaves the project, and a type that isn't one", async () => {
    const root = join(dir, 'save-2');
    const outside = join(dir, 'save-outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'media'));
    await expect(saveVoiceFile(root, 'kokoro', '.wav', new Uint8Array([1]))).rejects.toThrow(/outside the project/);
    expect(readdirSync(outside)).toEqual([]);
    await expect(saveVoiceFile(join(dir, 'save-1'), 'kokoro', '../../evil', new Uint8Array([1]))).rejects.toThrow(/not a file type/);
  });
});

describe('Kokoro', () => {
  let server: Server;
  let base = '';
  const files = new Map<string, Buffer>();
  const stage = join(dir, 'kokoro-archives');
  const tarball = (name: string, file: string): Buffer => {
    const at = join(stage, name);
    mkdirSync(join(at, 'package'), { recursive: true });
    writeFileSync(join(at, 'package', file), name);
    execFileSync('tar', ['-czf', `${at}.tgz`, '-C', at, 'package']);
    return readFileSync(`${at}.tgz`);
  };
  const manifest = (over: { sha?: string } = {}): KokoroManifest => ({
    version: 'kokoro-test',
    archives: ['/a.tgz', '/b.tgz', '/c.tgz'].map((path, i) => ({
      url: `${base}${path}`,
      sha256: over.sha ?? createHash('sha256').update(files.get(path)!).digest('hex'),
      bytes: files.get(path)!.length,
      into: ['runtime/sherpa-onnx-node', 'runtime/sherpa-onnx-test', 'model'][i],
    })),
  });

  beforeAll(async () => {
    files.set('/a.tgz', tarball('a', 'sherpa-onnx.js'));
    files.set('/b.tgz', tarball('b', 'sherpa-onnx.node'));
    files.set('/c.tgz', tarball('c', 'model.onnx'));
    server = createServer((req, res) => {
      const body = files.get(req.url ?? '');
      res.statusCode = body ? 200 : 404;
      res.end(body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it('pins every archive, and the version with espeak-ng', () => {
    const pinned = kokoroManifest('darwin-arm64')!;
    expect(pinned.archives).toHaveLength(3);
    for (const archive of pinned.archives) expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.archives[0].url).toContain('sherpa-onnx-node-1.13.8.tgz');
    expect(kokoroManifest('plan9-mips')).toBeNull();
    expect(new Kokoro(null, () => dir).status().state).toBe('unsupported');
  });

  it('knows speakers in both languages, by the numbers in the model', () => {
    expect(KOKORO_VOICES.find((v) => v.id === 'ef_dora')?.sid).toBe(28);
    expect(KOKORO_VOICES.find((v) => v.id === 'em_santa')?.sid).toBe(53);
    expect(KOKORO_VOICES.find((v) => v.id === 'af_heart')?.sid).toBe(3);
  });

  it('downloads, checks and unpacks, reporting progress', async () => {
    const home = join(dir, 'models-1');
    const kokoro = new Kokoro(manifest(), () => home);
    expect(kokoro.status().state).toBe('missing');
    const seen: number[] = [];
    await kokoro.install((done) => seen.push(done));
    expect(kokoro.status().state).toBe('ready');
    expect(seen.at(-1)).toBe(kokoro.status().bytes);
    expect(readFileSync(join(home, 'kokoro-test/model/model.onnx'), 'utf8')).toBe('c');
    expect(readFileSync(join(home, 'kokoro-test/runtime/sherpa-onnx-node/sherpa-onnx.js'), 'utf8')).toBe('a');
    expect(readdirSync(home)).toEqual(['kokoro-test']);
  });

  it('refuses an archive that fails its checksum, and leaves nothing behind', async () => {
    const home = join(dir, 'models-2');
    const kokoro = new Kokoro(manifest({ sha: '0'.repeat(64) }), () => home);
    await expect(kokoro.install()).rejects.toThrow(/pinned checksum/);
    expect(readdirSync(home)).toEqual([]);
    expect(kokoro.status()).toMatchObject({ state: 'missing', error: expect.stringContaining('pinned checksum') });
  });

  it('says what it needs before it speaks', () => {
    const kokoro = new Kokoro(manifest(), () => join(dir, 'models-3'));
    expect(() => kokoro.speak('hola', 'es')).toThrow(/isn't downloaded yet/);
    expect(() => kokoro.speak('hola', 'es', 'af_heart')).toThrow(/doesn't speak "es"/);
    expect(() => kokoro.speak('hola', 'fr')).toThrow(/no voice for "fr"/);
    expect(() => kokoro.speak('hola', 'es', 'nobody')).toThrow(/no voice "nobody"/);
    expect(() => kokoro.speak('   ', 'es')).toThrow(/no text/);
    expect(() => kokoro.speak('x'.repeat(6000), 'es')).toThrow(/one generation takes 5000/);
  });
});

describe("a project's code", () => {
  const rig = (marker: string) => `globalThis.process?.getBuiltinModule?.('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
export const marked = { id: 'marked', params: {}, draw() {} };
`;

  it('hashes what could run, and changes with it', () => {
    const root = join(dir, 'hash-1');
    expect(projectCode(root)).toMatchObject({ files: 0 });
    mkdirSync(join(root, 'rigs/parts'), { recursive: true });
    mkdirSync(join(root, 'projects/film/rigs'), { recursive: true });
    mkdirSync(join(root, 'scenes'), { recursive: true });
    writeFileSync(join(root, 'rigs/parts/a.ts'), 'one');
    writeFileSync(join(root, 'projects/film/rigs/b.ts'), 'two');
    writeFileSync(join(root, 'rigs/notes.md'), 'notes');
    const first = projectCode(root);
    expect(first.files).toBe(2);
    writeFileSync(join(root, 'scenes/x.json'), '{}');
    expect(projectCode(root).hash).toBe(first.hash);
    writeFileSync(join(root, 'rigs/parts/a.ts'), 'ONE');
    expect(projectCode(root).hash).not.toBe(first.hash);
    writeFileSync(join(root, 'rigs/parts/a.ts'), 'one');
    expect(projectCode(root).hash).toBe(first.hash);
    writeFileSync(join(root, 'rigs/notes.md'), 'changed');
    expect(projectCode(root).hash).not.toBe(first.hash);
  });

  it('calls a folder of notes no code at all', () => {
    const root = join(dir, 'hash-2');
    mkdirSync(join(root, 'audio'), { recursive: true });
    writeFileSync(join(root, 'audio/readme.md'), 'no code here');
    expect(projectCode(root).files).toBe(0);
  });

  it('loads none of it without trust, and serves none of it to pages', async () => {
    const root = join(dir, 'untrusted');
    const marker = join(root, 'ran.txt');
    mkdirSync(join(root, 'rigs'), { recursive: true });
    mkdirSync(join(root, 'projects/film/rigs'), { recursive: true });
    writeFileSync(join(root, 'rigs/marked.ts'), rig(marker));
    writeFileSync(join(root, 'projects/film/rigs/other.ts'), rig(marker));

    const folder = studioFolder(root, { untrusted: true });
    const loaded = await new CodeHost(folder).load();
    expect(existsSync(marker)).toBe(false);
    expect(loaded.folderRigs).toEqual([]);
    expect(loaded.projectRigs).toEqual({});
    expect(loaded.builtinRigs.length).toBeGreaterThan(0);
    expect(await withheldCode(folder)).toBe(2);

    const modules = new ModuleService(folder);
    const manifest = await modules.manifest();
    expect(manifest.folderRigs).toEqual([]);
    expect(manifest.projectRigs).toEqual({});
    expect(await modules.url(join(folder.builtins, 'rigs/index.ts'))).toContain('/b/rigs/index.ts');
    await expect(modules.url(join(root, 'rigs/marked.ts'))).rejects.toThrow(/not a module the studio serves/);

    const trusted = studioFolder(root);
    expect(await withheldCode(trusted)).toBe(0);
    expect((await new ModuleService(trusted).manifest()).folderRigs).toHaveLength(1);
  });
});
