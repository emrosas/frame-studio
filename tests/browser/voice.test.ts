/**
 * Word timing, captions and word anchors (ADR 0016), in a temporary studio
 * folder: the timing job against real voices, English and Spanish, through the
 * render worker's decode and whisper-cli; an HTML export of Spanish captions;
 * the voice row, with its clicks, drags, text edits and undo; anchors from a
 * right-click to a re-record. The timing tests need the pinned whisper-cli, the
 * model and the sample voices, and skip without them. Run npm run voice:setup.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpokenWord } from '../../src/engine/types';
import { buildEmbed } from '../../tools/bundle/embed';
import { Workspace } from '../../tools/mcp/workspace';
import { devBinary, modelPath } from '../../tools/voice/whisper';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

const SAMPLES = process.env.FRAME_STUDIO_VOICE_SAMPLES ?? '/Users/emireles/git/frame-studio/out/voice-test';
const REFERENCE = process.env.FRAME_STUDIO_VOICE_REFERENCE ?? '/private/tmp/claude-501/-Users-emireles-git-frame-studio/21a213d1-3e1f-4d4e-8236-c893bfb14fc2/scratchpad/voice/out';
const canListen = existsSync(devBinary()) && existsSync(modelPath()) && existsSync(join(SAMPLES, 'eleven-es.mp3')) && existsSync(REFERENCE);

const LINES = {
  en: "Why doesn't a lake freeze solid? Cold water sinks until it reaches four degrees. Then the crystals lock together and float.",
  es: '¿Por qué un lago no se congela por completo? El agua fría se hunde hasta llegar a cuatro grados. Entonces los cristales se unen y flotan.',
};
const WORDS: SpokenWord[] = [
  { id: 'w0', text: '¿Por', start: 0, end: 0.5 },
  { id: 'w1', text: 'qué', start: 0.5, end: 1 },
  { id: 'w2', text: 'el', start: 1, end: 1.5 },
  { id: 'w3', text: 'niño', start: 1.5, end: 2 },
  { id: 'w4', text: 'congeló', start: 2, end: 2.5 },
  { id: 'w5', text: 'año?', start: 2.5, end: 3 },
];

let folder: string;
let studio: TestStudio;
let browser: Browser;
let page: Page;

const path = (file: string) => join(folder, file);
const read = (id: string) => JSON.parse(readFileSync(path(`scenes/${id}.json`), 'utf8'));
const write = (id: string, value: unknown) => writeFileSync(path(`scenes/${id}.json`), JSON.stringify(value, null, 2));
const soon = <T>(value: () => T | Promise<T>) => expect.poll(value, { timeout: 15_000 });

const voiceScene = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  fps: 12,
  duration: 4,
  size: [640, 360],
  seed: 1,
  background: { rig: 'paper' },
  layers: [
    { id: 'ball', rig: 'circle', params: { x: 100, y: 100, radius: 30 }, tracks: [{ param: 'x', keys: [{ t: 0.25, v: 100 }, { t: 3, v: 500 }] }] },
    { id: 'subs', rig: 'captions', depth: 0, params: { cue: 'voice' } },
  ],
  audio: [{ id: 'voice', file: 'media/tone.wav', start: 0, end: 4, words: WORDS }],
  ...over,
});

/** A quiet second of WAV, so a scene has a file to play and a row to draw. */
function toneWav(seconds: number): Buffer {
  const rate = 48000;
  const samples = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 4000), 44 + i * 2);
  return out;
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-voice-'));
  for (const dir of ['scenes', 'media']) mkdirSync(path(dir), { recursive: true });
  writeFileSync(path('media/tone.wav'), toneWav(4));
  write('voice-row', voiceScene('voice-row'));
  write('words-undo', voiceScene('words-undo'));
  write('anchors', voiceScene('anchors', { markers: [{ t: 3.5, label: 'lock!' }] }));
  write('no-words', voiceScene('no-words', { audio: [{ id: 'voice', file: 'media/tone.wav', start: 0, end: 4 }], layers: [] }));
  write('spanish', voiceScene('spanish', { layers: [{ id: 'subs', rig: 'captions', params: { cue: 'voice', font: 'inter' } }] }));
  // A rig that imports the type modules switches the cut off, so this scene carries the whole typefaces to compare with.
  mkdirSync(path('rigs'), { recursive: true });
  writeFileSync(
    path('rigs/type-user.ts'),
    "import { typefaces } from '@frame-studio/rigs/type/faces/index';\nexport const typeUser = { id: 'type-user', params: {}, draw() { if (typefaces.length === 0) throw new Error('no typefaces'); } };\n",
  );
  write('spanish-whole', voiceScene('spanish', { id: 'spanish-whole', layers: [{ id: 'subs', rig: 'captions', params: { cue: 'voice', font: 'inter' } }, { id: 'nothing', rig: 'type-user' }] }));
  write('spanish-pixel', voiceScene('spanish-pixel', { size: [720, 1280], pixel: { scale: 4 }, layers: [{ id: 'subs', rig: 'captions', params: { cue: 'voice', font: 'pixel' } }] }));
  if (canListen) for (const file of ['eleven-en.mp3', 'eleven-es.mp3', 'kokoro-es.wav']) copyFileSync(join(SAMPLES, file), path(`media/${file}`));
  studio = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

async function open(scene: string): Promise<void> {
  await page.goto(studio.paired(`?scene=${scene}`));
  await page.waitForFunction((n) => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === n, 48);
  await page.waitForFunction(() => !!document.querySelector('.ruler')?.getBoundingClientRect().width);
}

async function workspace(): Promise<Workspace> {
  return studio.server.workspace();
}

describe.skipIf(!canListen)('timing real voices', () => {
  interface Reference {
    word: string;
    start: number;
    end: number;
  }
  const reference = (file: string) => JSON.parse(readFileSync(join(REFERENCE, `${file}.small.words.json`), 'utf8')) as Reference[];

  async function timed(id: string, file: string, lang: string, script?: string): Promise<SpokenWord[]> {
    write(id, { id, fps: 30, duration: 15, size: [1080, 1920], seed: 1, background: { rig: 'paper' }, layers: [], audio: [{ id: 'voice', file: `media/${file}`, start: 0, end: 15, lang }] });
    const result = await (await workspace()).alignVoice(id, 'voice', { script });
    expect(result.words).toBeGreaterThan(0);
    return read(id).audio[0].words;
  }

  it('keeps an edit made while it listened', async () => {
    await timed('edited-meanwhile', 'eleven-en.mp3', 'en', LINES.en);
    const scene = read('edited-meanwhile');
    delete scene.audio[0].words;
    write('edited-meanwhile', scene);
    await (await workspace()).alignVoice('edited-meanwhile', 'voice', {
      onProgress: ({ stage }) => {
        if (stage === 'write') write('edited-meanwhile', { ...scene, markers: [{ t: 1, label: 'made meanwhile' }] });
      },
    });
    const after = read('edited-meanwhile');
    expect(after.markers).toEqual([{ t: 1, label: 'made meanwhile' }]);
    expect(after.audio[0].words.length).toBeGreaterThan(0);
  });

  it('a voice from the Generate Voice sheet, placed at the playhead, gets the sheet\'s words from the timing job', async () => {
    process.env.FRAME_STUDIO_FAKE_KOKORO = '1';
    try {
      await open('no-words');
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Generate voice…' }).click();
      const sheet = page.getByRole('dialog', { name: 'Generate voice' });
      await sheet.getByRole('button', { name: 'Download Kokoro' }).click();
      await sheet.getByRole('radiogroup', { name: 'Voice' }).waitFor();
      await sheet.getByLabel('Language').selectOption('es');
      const script = '¿Por qué el lago no se congela?';
      await sheet.getByLabel('Text').fill(script);
      await sheet.getByRole('button', { name: 'Generate', exact: true }).click();
      await sheet.getByRole('button', { name: 'Place at playhead' }).click();
      await sheet.getByText('Placed at the playhead.').waitFor();
      const cue = () => read('no-words').audio.find((c: { file: string }) => c.file.startsWith('media/voice-kokoro-'));
      await expect.poll(() => cue()?.words?.length ?? 0, { timeout: 60_000 }).toBe(7);
      expect(cue().words.map((w: SpokenWord) => w.text).join(' ')).toBe(script);
      expect(cue()).toMatchObject({ script, lang: 'es' });
      await sheet.getByRole('button', { name: 'Close' }).click();
    } finally {
      delete process.env.FRAME_STUDIO_FAKE_KOKORO;
      write('no-words', voiceScene('no-words', { audio: [{ id: 'voice', file: 'media/tone.wav', start: 0, end: 4 }], layers: [] }));
    }
  }, 90_000);

  function near(words: readonly SpokenWord[], expected: readonly Reference[]): void {
    expect(words).toHaveLength(expected.length);
    words.forEach((word, i) => {
      expect(Math.abs(word.start - expected[i].start), `${word.text} starts at ${word.start}, reference ${expected[i].start}`).toBeLessThanOrEqual(0.15);
      expect(Math.abs(word.end - expected[i].end), `${word.text} ends at ${word.end}, reference ${expected[i].end}`).toBeLessThanOrEqual(0.15);
    });
  }

  it('Spanish, from the script, within 150 ms', async () => {
    const words = await timed('time-es', 'eleven-es.mp3', 'es', LINES.es);
    near(words, reference('eleven-es.mp3'));
    expect(words.map((w) => w.text).join(' ')).toBe(LINES.es);
  });

  it('English, from the script, within 150 ms', async () => {
    const words = await timed('time-en', 'eleven-en.mp3', 'en', LINES.en);
    near(words, reference('eleven-en.mp3'));
    expect(words.map((w) => w.text).join(' ')).toBe(LINES.en);
  });

  it('the script wins over what Whisper heard: ¿Por qué stays two words', async () => {
    const words = await timed('time-kokoro', 'kokoro-es.wav', 'es', LINES.es);
    expect(words.slice(0, 2).map((w) => w.text)).toEqual(['¿Por', 'qué']);
    expect(words).toHaveLength(LINES.es.split(' ').length);
  });

  it('keeps what Whisper said beside the file, out of the media list', async () => {
    const cache = JSON.parse(readFileSync(path('media/eleven-es.mp3.words.json'), 'utf8')) as { sha256: string; words: unknown[] };
    expect(cache.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.words.length).toBeGreaterThan(20);
    const list = await (await workspace()).listMedia();
    expect(list.some((m) => m.file.endsWith('.words.json'))).toBe(false);
  });

  it('a re-record keeps ids, and an anchor on a word that went stays put and shows as an orphan', async () => {
    const w = await workspace();
    const scene = read('time-es');
    const lastId = scene.audio[0].words.at(-1).id;
    scene.markers = [{ t: 1, label: 'locks', word: `voice#${lastId}` }];
    write('time-es', scene);
    const anchored = (await w.getScene('time-es')).scene as { audio: { words: SpokenWord[] }[] };
    const at = anchored.audio[0].words.at(-1)!.start;
    const result = await w.alignVoice('time-es', 'voice', { script: LINES.es.replace('flotan.', 'suben.') });
    expect(result.orphans).toEqual([`marker "locks": voice#${lastId}`]);
    const after = read('time-es');
    expect(after.markers[0].t).toBeCloseTo(at, 3);
    expect(after.audio[0].words.slice(0, 5).map((x: SpokenWord) => x.id)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
  });
});

describe('Spanish captions in an HTML export', () => {
  const pixels = async (file: string, frame: number) => {
    const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
    await p.goto(pathToFileURL(file).href);
    await p.waitForFunction(() => (window as unknown as { studio?: unknown }).studio !== undefined);
    await p.evaluate((f) => {
      const api = (window as unknown as { studio: { pause(): void; seek(n: number): void } }).studio;
      api.pause();
      api.seek(f);
    }, frame);
    const hash = await p.evaluate(() => (document.querySelector('canvas') as HTMLCanvasElement).toDataURL());
    await p.close();
    return hash;
  };

  it('cuts the typeface to the scene and draws every glyph the whole typeface would', async () => {
    const built = { folder: studio.server.folder, code: studio.server.code };
    const cut = await buildEmbed('spanish', built);
    const whole = await buildEmbed('spanish-whole', built);
    expect(cut.bytes.script).toBeLessThan(whole.bytes.script / 2);
    const cutFile = join(folder, 'cut.html');
    const wholeFile = join(folder, 'whole.html');
    writeFileSync(cutFile, cut.html);
    writeFileSync(wholeFile, whole.html);
    for (const frame of [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]) expect(await pixels(cutFile, frame), `frame ${frame}`).toBe(await pixels(wholeFile, frame));
  });

  it('keeps the captions when the sound stays out', async () => {
    const built = { folder: studio.server.folder, code: studio.server.code };
    const withWords = await buildEmbed('spanish', built);
    expect(withWords.mediaLeftOut).toEqual(['media/tone.wav']);
    expect(withWords.scene.spoken?.[0].words).toHaveLength(6);
    const file = join(folder, 'spanish.html');
    writeFileSync(file, withWords.html);
    expect(await pixels(file, 6)).not.toBe(await pixels(file, 40));
  });

  it('draws captions in the pixel font', async () => {
    const built = { folder: studio.server.folder, code: studio.server.code };
    const pixel = await buildEmbed('spanish-pixel', built);
    expect(pixel.rigs).toEqual(['captions', 'paper']);
    const file = join(folder, 'pixel.html');
    writeFileSync(file, pixel.html);
    expect(await pixels(file, 6)).not.toBe(await pixels(file, 44));
  });
});

describe('the voice row', () => {
  const chip = (id: string) => page.locator(`.word-chip[data-word="${id}"]`);
  const frame = () => page.evaluate(() => (window as unknown as { studio: { frame: number } }).studio.frame);

  it('shows a chip per word, with its text', async () => {
    await open('voice-row');
    await expect.poll(() => page.locator('.word-chip').count()).toBe(6);
    expect(await chip('w3').textContent()).toContain('niño');
  });

  it('a click puts the playhead on the word', async () => {
    await open('voice-row');
    await chip('w3').click();
    await soon(frame).toBe(18);
  });

  it('a drag across words sets a range', async () => {
    await open('voice-row');
    const from = (await chip('w1').boundingBox())!;
    const to = (await chip('w3').boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 8, to.y + 4, { steps: 8 });
    await page.mouse.up();
    await soon(() => page.locator('.ruler-range').evaluate((el) => !(el as HTMLElement).hidden)).toBe(true);
    const range = await page.locator('.ruler-range').evaluate((el) => (el as HTMLElement).style.left + ' ' + (el as HTMLElement).style.right);
    expect(range).toBe(`${(6 / 48) * 100}% ${100 - (24 / 48) * 100}%`);
  });

  it('an edge drag retimes the word and its neighbour, on a frame', async () => {
    await open('voice-row');
    const box = (await chip('w1').boundingBox())!;
    const handle = chip('w1').locator('[data-edge="end"]');
    const edge = (await handle.boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + box.width / 2, edge.y + 4, { steps: 6 });
    await page.mouse.up();
    await soon(() => read('voice-row').audio[0].words[1].end).toBeGreaterThan(1);
    const [, second, third] = read('voice-row').audio[0].words as SpokenWord[];
    expect(second.end).toBe(third.start);
    expect((second.end * 12) % 1).toBeCloseTo(0, 5);
  });

  it('a double-click edits the text, and Command-Z takes it back', async () => {
    await open('words-undo');
    await chip('w2').dblclick();
    await page.locator('.word-field').fill('él');
    await page.keyboard.press('Enter');
    await soon(() => read('words-undo').audio[0].words[2].text).toBe('él');
    await page.keyboard.press('Meta+z');
    await soon(() => read('words-undo').audio[0].words[2].text).toBe('el');
  });

  const editWords = (set: Record<string, unknown>) =>
    fetch(`${studio.base}__studio/layers`, {
      method: 'POST',
      headers: { ...studio.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'voice-row', layer: 'audio/voice', set }),
    });

  it('a word target takes only words', async () => {
    expect((await editWords({ start: 1 })).status).toBe(400);
  });

  it('the checked edit refuses words out of order', async () => {
    expect((await editWords({ words: [...WORDS].reverse() })).status).toBe(409);
  });

  it('locks while an agent works on the scene, as a hand edit does', async () => {
    await open('voice-row');
    await page.waitForSelector('.word-edge');
    const claimed = await studio.server.queue.create({ selection: { sceneId: 'voice-row', from: 0, to: 48 }, frame: 0, prompt: 'change it', references: [] });
    await studio.server.queue.claim(claimed.id, 'test-session');
    await page.waitForFunction(() => !document.querySelector('.word-edge'));
    expect((await editWords({ words: WORDS })).status).toBe(409);
    const timing = await fetch(`${studio.base}__studio/voice`, { method: 'POST', headers: { ...studio.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: 'voice-row', cue: 'voice' }) });
    expect(timing.status).toBe(409);
    await studio.server.queue.complete(claimed.id, 'done', 'changed');
    await page.waitForSelector('.word-edge');
  });

  it('a file cue with no words offers Timing, and asks before a download', async () => {
    await open('no-words');
    await page.route('**/__studio/voice', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { binary: true, model: false, modelBytes: 190085487, modelName: 'small q5' } });
      else await route.continue();
    });
    await page.locator('.sound-time').click();
    await expect.poll(() => page.locator('.voice-card').textContent()).toContain('190 MB');
    await page.unroute('**/__studio/voice');
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect.poll(() => page.locator('.voice-card').count()).toBe(0);
  });
});

describe('word anchors', () => {
  const diamond = () => page.locator('.tl-row[data-layer="ball"] .key-mark').first();
  const chip = (id: string) => page.locator(`.word-chip[data-word="${id}"]`);

  it('a right-click anchors the selected key, the diamond changes, and it follows the word', async () => {
    await open('anchors');
    await page.locator('.tl-row[data-layer="ball"]').click({ position: { x: 20, y: 6 } });
    await diamond().click();
    await chip('w3').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Anchor selected key here' }).click();
    await soon(() => read('anchors').layers[0].tracks[0].keys[0].word).toBe('voice#w3');
    expect(read('anchors').layers[0].tracks[0].keys[0].t).toBe(1.5);
    await soon(() => page.locator('.key-mark.is-anchored').count()).toBeGreaterThan(0);

    const scene = read('anchors');
    scene.audio[0].words[3] = { ...scene.audio[0].words[3], start: 1.75 };
    write('anchors', scene);
    await soon(() => page.locator('.tl-row[data-layer="ball"] .key-mark').first().evaluate((el) => (el as HTMLElement).style.left)).toBe(`${(21 / 48) * 100}%`);
  });

  it('dragging an anchored key lets it go', async () => {
    await open('anchors');
    await page.locator('.tl-row[data-layer="ball"]').click({ position: { x: 20, y: 6 } });
    const box = (await page.locator('.key-mark.is-anchored').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await soon(() => read('anchors').layers[0].tracks[0].keys[0].word).toBeUndefined();
    await soon(() => page.locator('.key-mark.is-anchored').count()).toBe(0);
  });

  it('a right-click anchors the selected marker', async () => {
    await open('anchors');
    await page.locator('.marker button').first().click();
    await chip('w1').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Anchor selected marker here' }).click();
    await soon(() => read('anchors').markers[0].word).toBe('voice#w1');
    expect(read('anchors').markers[0].t).toBe(0.5);
  });
});
