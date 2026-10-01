/**
 * M12 (ADR 0012): sound files in a studio folder outside the repo. The render
 * worker (Electron) decodes media/ files and renders them into the scene's one
 * audio buffer: trimmed by `in`, cut at `end`, faded, and inside a film when a
 * shot plays one. The studio server takes uploads and lists files with their
 * lengths, a missing file fails an export loudly, and the HTML export leaves
 * file cues out unless asked to inline them.
 *
 * The WAVs are written here, 16-bit at 48 kHz, so decoding is exact and every
 * sample can be checked: the file reads 0.25 for its first quarter second and
 * 0.5 after.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEmbed } from '../../tools/bundle/embed';
import type { Studio } from '../../tools/render/studio';
import { launchBrowser } from './browser';
import { renderClient, startStudio, type TestStudio } from './studio-server';

const RATE = 48000;

/** A 16-bit PCM WAV of `seconds`, `channels` wide, at `rate`. */
function wav(seconds: number, sample: (i: number) => number, rate = RATE, channels = 1): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(sample(i) * 32767), (i * channels + c) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// 0.25 for a quarter second, then 0.5: a trim of 0.25 s starts on the 0.5 part.
const tone = wav(2, (i) => (i < RATE / 4 ? 0.25 : 0.5));
// Chromium reads a 16-bit sample as value / 32767.
const LEVEL = Math.round(0.5 * 32767) / 32767;

let folder: string;
let studio: TestStudio;
let worker: Studio;

const scene = (id: string, audio: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, fps: 24, duration: 2, size: [640, 360], seed: 1, background: { rig: 'paper' }, layers: [], audio, ...extra });

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-media-'));
  for (const dir of ['scenes', 'media', 'projects/p']) mkdirSync(join(folder, dir), { recursive: true });
  writeFileSync(join(folder, 'media/tone.wav'), tone);
  writeFileSync(join(folder, 'scenes/voice.json'), scene('voice', [{ id: 'v', file: 'media/tone.wav', start: 0.5, end: 1.5, in: 0.25, fadeIn: 0.1, fadeOut: 0.2 }]));
  writeFileSync(join(folder, 'scenes/loud.json'), scene('loud', [{ id: 'v', file: 'media/tone.wav', start: 0, end: 1, in: 0.5, tracks: [{ param: 'volume', keys: [{ t: 0, v: 0.5 }] }] }]));
  writeFileSync(join(folder, 'scenes/missing.json'), scene('missing', [{ id: 'v', file: 'media/nope.wav', start: 0, end: 1 }]));
  writeFileSync(join(folder, 'projects/p/project.json'), JSON.stringify({ fps: 24, size: [640, 360], main: 'film' }));
  writeFileSync(join(folder, 'projects/p/shot.json'), scene('shot', [{ id: 'v', file: 'media/tone.wav', start: 0, end: 1, in: 0.25 }], { duration: 1 }));
  writeFileSync(join(folder, 'projects/p/film.json'), scene('film', [], { layers: [{ id: 'shot', scene: 'shot', start: 0.5 }] }));
  // HMR on, as in the tests that click the viewer: without it Vite's client trips the boot guard.
  studio = await startStudio({ folder, hmr: true });
  worker = await renderClient(studio, 'voice');
});

afterAll(async () => {
  await worker?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

const samples = (from: number, to: number, channel = 0) => worker.call('audioSamples', from, to, channel) as Promise<number[]>;
const at = async (i: number) => (await samples(i, i + 1))[0];
const peak = (from: number, to: number) => worker.call('audioPeak', from, to) as Promise<number>;

describe('a sound file cue', () => {
  it('plays the file from `in`, between start and end, faded in and out, and nothing around it', async () => {
    await worker.load('voice');
    const start = 0.5 * RATE;
    const end = 1.5 * RATE;
    expect(await peak(0, start)).toBe(0);
    expect(await peak(end, 2 * RATE)).toBe(0);
    // The fade in: silence on the first sample, halfway at 0.05 s, full at 0.1 s; the trim skipped the 0.25 part.
    expect(await at(start)).toBe(0);
    expect(await at(start + 2400)).toBeCloseTo(LEVEL / 2, 6);
    expect(await at(start + 4800)).toBeCloseTo(LEVEL, 6);
    expect(await peak(start + 4800, end - 9600)).toBeCloseTo(LEVEL, 6);
    expect(await at(start + 0.5 * RATE)).toBeCloseTo(LEVEL, 6);
    // The fade out over the last 0.2 s.
    expect(await at(end - 1)).toBe(0);
    // 0.2 s is 9600 samples; the one 4800 from the end is 4799/9600 of the way up.
    expect(await at(end - 4800)).toBeCloseTo((LEVEL * 4799) / 9600, 6);
    // A mono file plays on both channels.
    expect(await samples(start + 6000, start + 6010, 1)).toEqual(await samples(start + 6000, start + 6010, 0));
  });

  it('follows its volume keys, and renders the same samples again', async () => {
    await worker.load('loud');
    const [v] = await samples(1000, 1001);
    expect(v).toBeCloseTo(LEVEL / 2, 6);
    const first = await worker.call('audioHash');
    await worker.load('voice');
    await worker.load('loud');
    expect(await worker.call('audioHash')).toBe(first);
  });

  it("plays inside a film when a placed shot plays it, shifted to the shot's start", async () => {
    await worker.load('p/film');
    expect(await peak(0, 0.5 * RATE)).toBe(0);
    expect(await at(0.5 * RATE)).toBeCloseTo(LEVEL, 6);
    expect(await at(1.5 * RATE - 1)).toBeCloseTo(LEVEL, 6);
    expect(await peak(1.5 * RATE, 2 * RATE)).toBe(0);
  });

  it('fails loudly when its file is missing, so an export never drops it quietly', async () => {
    await worker.load('missing');
    await expect(samples(0, 10)).rejects.toThrow(/media\/nope\.wav isn't in the studio folder's media/);
  });
});

describe('the studio server', () => {
  it('takes an upload into media/ under a clean name, and lists files with their lengths', async () => {
    const upload = (name: string, type: string) =>
      fetch(`${studio.base}__studio/media?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...studio.auth, 'Content-Type': type }, body: new Uint8Array(wav(1.5, () => 0.1)) });
    const res = await upload('My Voice Take (final).WAV', 'audio/wav');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ file: 'media/my-voice-take-final.wav' });
    expect(await (await upload('My Voice Take (final).wav', 'audio/wav')).json()).toEqual({ file: 'media/my-voice-take-final-2.wav' });
    // A form on another site can't send these types without a preflight it fails.
    expect((await upload('x.wav', 'text/plain')).status).toBe(415);
    expect((await upload('notes.txt', 'audio/wav')).status).toBe(415);

    const { media } = (await (await fetch(`${studio.base}__studio/media`, { headers: studio.auth })).json()) as { media: { file: string; duration?: number }[] };
    expect(media.find((m) => m.file === 'media/tone.wav')?.duration).toBe(2);
    expect(media.find((m) => m.file === 'media/my-voice-take-final.wav')?.duration).toBe(1.5);
    const served = await fetch(`${studio.base}__studio/media/tone.wav`, { headers: studio.auth });
    expect(served.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await served.arrayBuffer()).equals(tone)).toBe(true);
    expect((await fetch(`${studio.base}__studio/media/..%2Fscenes%2Fvoice.json`, { headers: studio.auth })).status).toBe(404);
  });
});

describe('the HTML export', () => {
  const built = () => ({ folder: studio.server.folder, code: studio.server.code });

  it('leaves sound file cues out by default, and says which', async () => {
    const embed = await buildEmbed('voice', built());
    expect(embed.mediaLeftOut).toEqual(['media/tone.wav']);
    expect(embed.media).toEqual([]);
    expect(embed.html).not.toContain('media/tone.wav');
    expect(embed.bytes.total).toBeLessThan(100 * 1024);
  });

  it('inlines them when asked, and plays them', async () => {
    const embed = await buildEmbed('voice', { ...built(), media: true });
    expect(embed.media).toEqual(['media/tone.wav']);
    expect(embed.mediaLeftOut).toEqual([]);
    expect(embed.html).toContain(tone.toString('base64').slice(0, 200));
    const file = join(folder, 'out-voice.html');
    writeFileSync(file, embed.html);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`file://${file}?autoplay=0`);
      type W = { studio: { sound?: { ready: boolean; error?: string } } };
      await page.waitForFunction(() => (window as unknown as W).studio?.sound?.ready === true || !!(window as unknown as W).studio?.sound?.error, null, { timeout: 15000 });
      expect(await page.evaluate(() => (window as unknown as W).studio.sound)).toMatchObject({ ready: true });
    } finally {
      await browser.close();
    }
  });
});

describe('the viewer', () => {
  it('imports by picker and by drop, places a file at the playhead, shows its waveform, and reports a missing file', async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      type W = { studio: { frameCount: number; errors: string[] } };
      await page.goto(studio.paired('?scene=voice&frame=12'));
      await page.waitForFunction(() => (window as unknown as W).studio?.frameCount === 48);
      const media = page.getByRole('region', { name: 'Media' });
      await media.getByText('tone.wav').waitFor();
      await expect.poll(() => media.textContent()).toContain('2s');

      await media.locator('input[type=file]').setInputFiles({ name: 'Music Bed.wav', mimeType: 'audio/wav', buffer: wav(1.5, () => 0.3) });
      await media.getByText('music-bed.wav').waitFor();

      // A file dropped on the canvas imports too.
      const bytes = [...wav(0.5, () => 0.2)];
      await page.evaluate((data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], 'dropped.wav', { type: 'audio/wav' }));
        const target = document.querySelector('.stage')!;
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, bytes);
      await media.getByText('dropped.wav').waitFor();

      // Frame 12 at 24 fps is 0.5 s; the 1.5 s file runs to the scene's end at 2 s.
      await media.getByRole('button', { name: 'Add music-bed.wav at the playhead' }).click();
      await expect
        // The first call starts the server's workspace, which takes a moment.
        .poll(() => JSON.parse(readFileSync(join(folder, 'scenes/voice.json'), 'utf8')).audio.find((c: { id: string }) => c.id === 'music-bed'), { timeout: 10000 })
        .toEqual({ id: 'music-bed', file: 'media/music-bed.wav', start: 0.5, end: 2 });
      const band = page.getByRole('group', { name: 'Sounds' }).getByRole('img', { name: 'Sound music-bed.wav' });
      await band.waitFor();
      await band.locator('svg path').waitFor();

      await page.goto(studio.paired('?scene=missing'));
      await expect.poll(() => page.evaluate(() => (window as unknown as W).studio?.errors?.join('\n') ?? ''), { timeout: 15000 }).toMatch(/media\/nope\.wav isn't in the studio folder's media/);
    } finally {
      await browser.close();
    }
  });
});
