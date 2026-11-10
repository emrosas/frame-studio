/**
 * Dragging from the Library onto the timeline. Over the scene you came from the library leaves the dock in view.
 * A scene card or picture lands as a clip on the track under the pointer, a new track above or below the tracks or
 * above a full one, and a sound file as a cue, at the drop time, snapped like a clip drag. A scene refuses pictures
 * with a note. Files from the computer import, then land the same way. Each drop is one step of Command-Z.
 * DROP_SHOTS=<dir> saves the window mid-drag.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

let folder: string;
let server: TestStudio;
let browser: Browser;
let page: Page;

/** Seconds of a quiet tone, as 16-bit 48 kHz mono WAV. */
function tone(seconds: number): Buffer {
  const samples = Math.round(seconds * 48000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / 48000) * 2 * Math.PI * 440) * 4000), 44 + i * 2);
  return wav;
}

/** A 1x1 grey PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64');

const scene = (id: string, paper: string) => ({
  id,
  fps: 12,
  duration: 2,
  size: [640, 360],
  seed: 1,
  background: { rig: 'paper', params: { tone: paper } },
  layers: [{ id: 'dot', rig: 'circle', params: { x: 200, y: 180, radius: 60 } }],
});

const COMPOSITION = {
  id: 'cut',
  fps: 12,
  duration: 6,
  size: [640, 360],
  background: '#101010',
  tracks: [
    { id: 'V1', clips: [{ id: 'one', scene: 'a', start: 0.5 }, { id: 'two', scene: 'b', start: 2.5 }] },
    { id: 'V2', clips: [] },
  ],
  audio: [{ id: 'music', file: 'media/tone.wav', start: 1, end: 4 }],
  markers: [{ t: 3, label: 'beat' }],
};

type Clip = { id: string; scene?: string; file?: string; start?: number; out?: number };
const read = (path = 'compositions/cut.json') => JSON.parse(readFileSync(join(folder, path), 'utf8'));
const tracks = () => (read().tracks as { id: string; clips: Clip[] }[]).map((t) => [t.id, t.clips.map((c) => c.id)]);
const clip = (id: string) => (read().tracks as { clips: Clip[] }[]).flatMap((t) => t.clips).find((c) => c.id === id)!;
const waitFile = (test: () => unknown, value: unknown) => expect.poll(test, { timeout: 8000 }).toEqual(value);
const library = () => page.getByRole('region', { name: 'Library' });
const card = (key: string) => library().locator(`.lib-card[data-key="${key}"]`);
const mediaRow = (file: string) => library().locator(`.lib-media[data-media="${file}"]`);

async function openLibrary(): Promise<void> {
  await page.getByRole('list', { name: 'Projects' }).locator('.project-row').first().click();
  await library().waitFor();
}

/** The point on the timeline at a frame boundary, at the height of `row` (or `y` px into it). */
async function at(frame: number, row: Locator, y = 0.5): Promise<{ x: number; y: number }> {
  const ruler = (await page.locator('.ruler').boundingBox())!;
  const total = await page.evaluate(() => (window as unknown as { studio: { frameCount: number } }).studio.frameCount);
  const box = (await row.boundingBox())!;
  return { x: ruler.x + (frame / total) * ruler.width + 0.5, y: box.y + box.height * y };
}

let shots = 0;

/** Drags `source` to `to` with the mouse, as a person would, and returns what the ghost said on the way. */
async function dragOnto(source: Locator, to: { x: number; y: number }): Promise<string> {
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(to.x, to.y - 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  const note = (await page.locator('.drop-note').textContent({ timeout: 2000 }).catch(() => null)) ?? '';
  if (process.env.DROP_SHOTS) await page.screenshot({ path: join(process.env.DROP_SHOTS, `drop-${++shots}.png`) });
  await page.mouse.up();
  return note;
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-drop-'));
  for (const dir of ['scenes', 'compositions', 'media']) mkdirSync(join(folder, dir));
  writeFileSync(join(folder, 'scenes/a.json'), JSON.stringify(scene('a', '#f4efe6')));
  writeFileSync(join(folder, 'scenes/b.json'), JSON.stringify(scene('b', '#cfe0f4')));
  writeFileSync(join(folder, 'media/tone.wav'), tone(8));
  writeFileSync(join(folder, 'media/still.png'), PNG);
  server = await startStudio({ folder, hmr: true });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(folder, { recursive: true, force: true });
});

beforeEach(async () => {
  writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify(COMPOSITION));
  writeFileSync(join(folder, 'scenes/a.json'), JSON.stringify(scene('a', '#f4efe6')));
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(server.paired('?scene=cut'));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 72);
  await page.locator('.shot-band[data-layer="one"]').waitFor();
});

afterEach(async () => {
  await page.close();
});

describe('dropping from the Library', () => {
  it('keeps the dock in view under the library opened from a scene', async () => {
    await openLibrary();
    const dock = page.locator('footer.dock');
    expect(await dock.getAttribute('inert')).toBeNull();
    const lib = (await library().boundingBox())!;
    const box = (await dock.boundingBox())!;
    expect(box.height).toBeGreaterThan(60);
    expect(lib.y + lib.height).toBeLessThanOrEqual(box.y + 1);
  });

  it('drops a scene card on the track under the pointer at the drop time, as one undo step', async () => {
    await openLibrary();
    // V2 is the top row.
    const note = await dragOnto(card('b'), await at(30, page.locator('.track-lane').first()));
    expect(note).toMatch(/^b at 0:02\.50 on V2$/);
    await waitFile(tracks, [
      ['V1', ['one', 'two']],
      ['V2', ['b']],
    ]);
    expect(clip('b')).toEqual({ id: 'b', scene: 'b', start: 2.5 });
    await expect(page.locator('.drop-note').count()).resolves.toBe(0);
    // The library is still up, and Command-Z still reaches the drop.
    await library().waitFor();
    await page.keyboard.press('Meta+z');
    await waitFile(tracks, [
      ['V1', ['one', 'two']],
      ['V2', []],
    ]);
  });

  it('snaps a drop to a marker, as a clip drag does', async () => {
    writeFileSync(join(folder, 'compositions/long.json'), JSON.stringify({ id: 'long', fps: 12, duration: 60, size: [640, 360], tracks: [{ id: 'V1', clips: [{ id: 'x', scene: 'a' }] }], markers: [{ t: 20, label: 'beat' }] }));
    await page.goto(server.paired('?scene=long'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 720);
    await openLibrary();
    // Frame 236 is about 3 px from the marker's frame 240 at this zoom, inside the 6 px snap.
    expect(await dragOnto(card('b'), await at(236, page.locator('.track-lane').first()))).toMatch(/^b at 0:20\.00 on V1$/);
    await waitFile(() => read('compositions/long.json').tracks[0].clips[1], { id: 'b', scene: 'b', start: 20 });
  });

  it('puts a clip on a new track above a full one, below the tracks at the bottom, and above them on top', async () => {
    await openLibrary();
    const v1 = page.locator('.track-lane').nth(1);
    expect(await dragOnto(card('a'), await at(36, v1))).toMatch(/on a new track above V1$/);
    await waitFile(tracks, [
      ['V1', ['one', 'two']],
      ['V3', ['a']],
      ['V2', []],
    ]);
    // Each new track grows the dock, which moves the rows: measure once it has.
    const lanes = (n: number) => expect.poll(() => page.locator('.track-lane').count()).toBe(n);
    await lanes(3);
    expect(await dragOnto(mediaRow('media/still.png'), await at(12, page.locator('.sounds'), 0.5))).toMatch(/on a new track at the bottom$/);
    await waitFile(() => tracks()[0], ['V4', ['still']]);
    expect(clip('still')).toEqual({ id: 'still', file: 'media/still.png', start: 1, out: 3 });
    await lanes(4);
    expect(await dragOnto(card('b'), await at(0, page.locator('.ruler'), 0.9))).toMatch(/on a new track on top$/);
    await waitFile(() => tracks().at(-1), ['V5', ['b']]);
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await waitFile(tracks, [
      ['V1', ['one', 'two']],
      ['V2', []],
    ]);
  });

  it('drops a sound file as a cue at the drop time, and Command-Z takes it back', async () => {
    await openLibrary();
    const note = await dragOnto(mediaRow('media/tone.wav'), await at(60, page.locator('.shots')));
    expect(note).toMatch(/^tone\.wav at 0:05\.00$/);
    await waitFile(() => read().audio.length, 2);
    expect(read().audio[1]).toEqual({ id: 'tone', file: 'media/tone.wav', start: 5, end: 6 });
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio.length, 1);
  });

  it('refuses a picture or a scene in a scene with a note, and still takes sound there', async () => {
    await page.goto(server.paired('?scene=a'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 24);
    await openLibrary();
    const row = page.locator('.tl-rows');
    expect(await dragOnto(mediaRow('media/still.png'), await at(6, row))).toMatch(/go in a video, not a scene/);
    await expect.poll(() => page.locator('.sel-notice').textContent()).toMatch(/go in a video, not a scene/);
    expect(await dragOnto(card('b'), await at(6, row))).toMatch(/places nothing/);
    expect(read('scenes/a.json')).toEqual(scene('a', '#f4efe6'));
    await dragOnto(mediaRow('media/tone.wav'), await at(6, row));
    await waitFile(() => read('scenes/a.json').audio, [{ id: 'tone', file: 'media/tone.wav', start: 0.5, end: 2 }]);
  });

  it('imports a file dropped from the computer and places it where it landed', async () => {
    const point = await at(24, page.locator('.shots'));
    const bytes = [...tone(0.5)];
    await page.evaluate(
      ({ bytes, point }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'clap.wav', { type: 'audio/wav' }));
        const target = document.elementFromPoint(point.x, point.y)!;
        const init = { dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true };
        target.dispatchEvent(new DragEvent('dragover', init));
        target.dispatchEvent(new DragEvent('drop', init));
      },
      { bytes, point },
    );
    await waitFile(() => read().audio.length, 2);
    expect(read().audio[1]).toEqual({ id: 'clap', file: 'media/clap.wav', start: 2, end: 2.5 });
    // The window's own import didn't also open the library.
    expect(await library().count()).toBe(0);
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio.length, 1);
  });
});
