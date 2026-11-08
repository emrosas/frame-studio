/**
 * M15: the timeline as an editor (ADR 0018), driven with the mouse and keys. A split changes no frame. Clips are
 * added, duplicated, deleted and dragged between tracks, drags land on the playhead and other edges, sound moves,
 * trims and fades, transitions write plain keys, and each of these is one step of Command-Z, restoring the file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Studio } from '../../tools/render/studio';
import { launchBrowser } from './browser';
import { renderClient, startStudio, type TestStudio } from './studio-server';

let folder: string;
let server: TestStudio;
let browser: Browser;
let page: Page;

/** A second of a quiet 440 Hz tone per `seconds`, as 16-bit 48 kHz mono WAV. */
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
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / 48000) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return wav;
}

const scene = (id: string, paper: string, x: number) => ({
  id,
  fps: 12,
  duration: 2,
  size: [640, 360],
  seed: 1,
  background: { rig: 'paper', params: { tone: paper } },
  layers: [{ id: 'dot', rig: 'circle', params: { x, y: 180, radius: 60 }, tracks: [{ param: 'x', keys: [{ t: 0, v: 80 }, { t: 2, v: 560, ease: 'inOutCubic' }] }] }],
});

const COMPOSITION = {
  id: 'cut',
  fps: 12,
  duration: 6,
  size: [640, 360],
  background: '#101010',
  tracks: [
    { id: 'V1', clips: [{ id: 'one', scene: 'a', start: 0.5, tracks: [{ param: 'opacity', keys: [{ t: 0.5, v: 0 }, { t: 1, v: 1, ease: 'inOutCubic' }, { t: 2, v: 0.5, ease: 'inOutCubic' }] }] }, { id: 'two', scene: 'b', start: 2.5 }] },
    { id: 'V2', clips: [] },
  ],
  audio: [{ id: 'music', file: 'media/tone.wav', start: 1, end: 4, in: 0.5 }],
  markers: [{ t: 3, label: 'beat' }],
};

const read = (path = 'compositions/cut.json') => JSON.parse(readFileSync(join(folder, path), 'utf8'));
const clips = () => read().tracks.flatMap((t: { clips: { id: string }[] }) => t.clips) as { id: string; start?: number; in?: number; out?: number; mask?: { rig: string }; tracks?: { param: string }[] }[];
const clip = (id: string) => clips().find((c) => c.id === id)!;
const studioApi = () =>
  page.evaluate(() => {
    const { frame, frameCount, selection } = (window as unknown as { studio: { frame: number; frameCount: number; selection: { layerId?: string | null } | null } }).studio;
    return { frame, frameCount, layer: selection?.layerId ?? null };
  });
const band = (id: string) => page.locator(`.shot-band[data-layer="${id}"]`);
const cueBand = (id: string) => page.locator(`.sound-band[data-cue="${id}"]`);
const waitFile = (test: () => unknown, value: unknown) => expect.poll(test, { timeout: 8000 }).toEqual(value);

async function perFrame(): Promise<{ x: number; px: number }> {
  const box = (await page.locator('.ruler').boundingBox())!;
  return { x: box.x, px: box.width / (await studioApi()).frameCount };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** Clicks a band to select it, and takes the keyboard back from it. */
async function select(id: string): Promise<void> {
  await band(id).click({ position: { x: 12, y: 6 } });
  await expect.poll(async () => (await studioApi()).layer).toBe(id);
}

async function seek(frame: number): Promise<void> {
  await page.evaluate((to) => (window as unknown as { studio: { seek(f: number): void } }).studio.seek(to), frame);
  await expect.poll(async () => (await studioApi()).frame).toBe(frame);
}

async function hashes(worker: Studio, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let frame = 0; frame < count; frame++) out.push(await worker.call('pixelHash', frame));
  return out;
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-editor-'));
  for (const dir of ['scenes', 'compositions', 'media']) mkdirSync(join(folder, dir));
  writeFileSync(join(folder, 'scenes/a.json'), JSON.stringify(scene('a', '#f4efe6', 80)));
  writeFileSync(join(folder, 'scenes/b.json'), JSON.stringify(scene('b', '#cfe0f4', 200)));
  writeFileSync(join(folder, 'media/tone.wav'), tone(8));
  writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify(COMPOSITION));
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
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(server.paired('?scene=cut'));
  await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 72);
  await band('one').waitFor();
  await page.mouse.move(2, 2);
});

afterEach(async () => {
  await page.close();
});

describe('clips', () => {
  it('splits at the playhead with S, changes no frame, and Command-Z takes it back', async () => {
    const worker = await renderClient(server, 'cut');
    const before = await hashes(worker, 40);
    await select('one');
    await seek(15);
    await page.keyboard.press('s');
    await waitFile(() => clips().map((c) => c.id), ['one', 'one-2', 'two']);
    expect(clip('one')).toMatchObject({ start: 0.5, out: 0.75 });
    expect(clip('one-2')).toMatchObject({ start: 1.25, in: 0.75 });
    await expect.poll(async () => (await studioApi()).layer).toBe('one-2');
    const reopened = await renderClient(server, 'cut');
    expect(await hashes(reopened, 40)).toEqual(before);

    await page.keyboard.press('Meta+z');
    await waitFile(() => clips().map((c) => c.id), ['one', 'two']);
    expect(clip('one').out).toBeUndefined();
    await page.keyboard.press('Meta+Shift+z');
    await waitFile(() => clips().map((c) => c.id), ['one', 'one-2', 'two']);
  });

  it('duplicates with Command-D, deletes with Delete, and undoes both in turn', async () => {
    await select('two');
    await page.keyboard.press('Meta+d');
    await waitFile(() => clips().map((c) => c.id), ['one', 'two', 'two-2']);
    expect(clip('two-2').start).toBe(4.5);
    await expect.poll(async () => (await studioApi()).layer).toBe('two-2');
    await page.keyboard.press('Delete');
    await waitFile(() => clips().map((c) => c.id), ['one', 'two']);
    await expect.poll(async () => (await studioApi()).layer).toBeNull();
    await page.keyboard.press('Meta+z');
    await waitFile(() => clips().map((c) => c.id), ['one', 'two', 'two-2']);
    await page.keyboard.press('Meta+z');
    await waitFile(() => clips().map((c) => c.id), ['one', 'two']);
  });

  it('adds a scene at the playhead, on the lowest track with room, and grows the video to hold it', async () => {
    await seek(66);
    await page.getByRole('button', { name: 'Clip', exact: true }).click();
    await page.getByRole('menuitem', { name: 'a', exact: true }).click();
    await waitFile(() => read().tracks[0].clips.map((c: { id: string }) => c.id), ['one', 'two', 'a']);
    expect(clip('a').start).toBe(5.5);
    expect(read().duration).toBe(7.5);
    await expect.poll(async () => (await studioApi()).frameCount).toBe(90);
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().duration, 6);
    expect(clips().map((c) => c.id)).toEqual(['one', 'two']);
  });

  it('has no menu entry for the video itself, and offers its other scenes', async () => {
    await page.getByRole('button', { name: 'Clip', exact: true }).click();
    await page.getByRole('menuitem', { name: 'b', exact: true }).waitFor();
    expect(await page.getByRole('menuitem', { name: 'cut', exact: true }).count()).toBe(0);
  });

  it('shows real tracks, top of the stack first, and a drag moves a clip to another, as one step', async () => {
    expect(await page.locator('.tl-section').first().locator('.row-head').allTextContents().then((t) => t.map((s) => s.trim()))).toEqual(['V2', 'V1']);
    const box = (await band('two').boundingBox())!;
    expect(box.y).toBeGreaterThan((await page.locator('.track-lane').first().boundingBox())!.y + 10);
    await drag({ x: box.x + 40, y: box.y + 8 }, { x: box.x + 40, y: box.y + 8 - box.height - 4 });
    await waitFile(() => read().tracks[1].clips.map((c: { id: string }) => c.id), ['two']);
    expect(clip('two').start).toBe(2.5);
    await expect.poll(async () => (await band('two').boundingBox())!.y).toBeLessThan(box.y);
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().tracks[0].clips.map((c: { id: string }) => c.id), ['one', 'two']);
  });

  it('adds a track on top, and an empty one can go', async () => {
    await page.getByRole('button', { name: 'Track', exact: true }).click();
    await waitFile(() => read().tracks.map((t: { id: string }) => t.id), ['V1', 'V2', 'V3']);
    await page.getByRole('button', { name: 'Remove track V3' }).click();
    await waitFile(() => read().tracks.map((t: { id: string }) => t.id), ['V1', 'V2']);
    expect(await page.getByRole('button', { name: 'Remove track V1' }).count()).toBe(0);
  });

  it('lands a dragged clip on the playhead, a marker or another clip\'s edge, and leaves it free elsewhere', async () => {
    writeFileSync(
      join(folder, 'compositions/long.json'),
      JSON.stringify({ id: 'long', fps: 12, duration: 60, size: [640, 360], tracks: [{ id: 'V1', clips: [{ id: 'x', scene: 'a' }, { id: 'y', scene: 'b', start: 10 }] }], markers: [{ t: 20, label: 'beat' }] }),
    );
    await page.goto(server.paired('?scene=long&frame=300'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 720);
    await band('y').waitFor();
    const start = () => read('compositions/long.json').tracks[0].clips[1].start;
    const shown = () => page.evaluate(() => (window as unknown as { studio: { shots: { from: number }[] } }).studio.shots[1].from);
    const { x, px } = await perFrame();
    expect(px).toBeLessThan(2);
    const moveTo = async (frame: number) => {
      const box = (await band('y').boundingBox())!;
      const grab = box.width / 2;
      const y = box.y + 8;
      await drag({ x: box.x + grab, y }, { x: x + frame * px + grab, y });
    };
    // Three frames short of each target, inside the 6 px.
    await moveTo(297);
    await expect.poll(start).toBe(25);
    await expect.poll(shown).toBe(300);
    await moveTo(243);
    await expect.poll(start).toBe(20);
    await expect.poll(shown).toBe(240);
    await moveTo(27);
    await expect.poll(start).toBe(2);
    await expect.poll(shown).toBe(24);
    // Nowhere near anything, it stays on the frame it was dropped on, give or take the pixel.
    await moveTo(500);
    await expect.poll(shown).not.toBe(24);
    expect(Math.abs((await shown()) - 500)).toBeLessThan(3);
    rmSync(join(folder, 'compositions/long.json'));
  });

  it('writes a wipe as a mask with plain keys, which draws, and takes it off again', async () => {
    const worker = await renderClient(server, 'cut');
    const bare = await worker.call('pixelHash', 30);
    await band('two').click({ button: 'right', position: { x: 12, y: 6 } });
    await page.getByRole('menuitem', { name: 'Wipe in' }).click();
    await waitFile(() => clip('two').mask?.rig, 'mask-wipe');
    expect(read().tracks[0].clips[1].mask.tracks[0].keys).toEqual([{ t: 2.5, v: 0 }, { t: 3, v: 1, ease: 'inOutCubic' }]);
    const wiped = await renderClient(server, 'cut');
    expect(await wiped.call('pixelHash', 33)).not.toBe(bare);
    await band('two').click({ button: 'right', position: { x: 12, y: 6 } });
    await page.getByRole('menuitem', { name: 'Remove transition' }).click();
    await waitFile(() => clip('two').mask, undefined);
  });

  it('runs the clip before on under a crossfade', async () => {
    writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify({ ...COMPOSITION, tracks: [{ id: 'V1', clips: [{ id: 'one', scene: 'a', out: 1 }, { id: 'two', scene: 'b', start: 1 }] }] }));
    await expect.poll(() => band('one').boundingBox().then((b) => b?.width ?? 0)).toBeLessThan(200);
    await band('two').click({ button: 'right', position: { x: 12, y: 6 } });
    await page.getByRole('menuitem', { name: 'Crossfade in' }).click();
    await waitFile(() => clip('one').out, 1.5);
    expect(clip('two').tracks![0]).toMatchObject({ param: 'opacity', keys: [{ t: 1, v: 0 }, { t: 1.5, v: 1 }] });
  });

  it('refuses edits while an agent works, and changes nothing', async () => {
    const claimed = await server.server.queue.create({ selection: { sceneId: 'cut', from: 0, to: 72 }, frame: 0, prompt: 'cut it', references: [] });
    await server.server.queue.claim(claimed.id, 'test-session');
    await expect.poll(() => page.getByRole('button', { name: 'Clip', exact: true }).isDisabled()).toBe(true);
    await select('two');
    await page.keyboard.press('Delete');
    await expect.poll(() => page.locator('.sel-notice').textContent()).toMatch(/agent is working/);
    expect(clips().map((c) => c.id)).toEqual(['one', 'two']);
    await server.server.queue.complete(claimed.id, 'done', 'nothing');
  });
});

describe('sound', () => {
  it('moves a cue with a drag, and Command-Z puts it back', async () => {
    await page.waitForSelector('.sound-band .waveform');
    const { px } = await perFrame();
    const box = (await cueBand('music').boundingBox())!;
    await seek(0);
    await drag({ x: box.x + 40, y: box.y + 10 }, { x: box.x + 40 + 12 * px, y: box.y + 10 });
    await waitFile(() => read().audio[0].start, 2);
    expect(read().audio[0]).toMatchObject({ end: 5, in: 0.5 });
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio[0].start, 1);
  });

  it('trims each end, moving what the file plays from', async () => {
    const { px } = await perFrame();
    const box = (await cueBand('music').boundingBox())!;
    await cueBand('music').hover();
    await drag({ x: box.x + 2, y: box.y + 12 }, { x: box.x + 2 + 6 * px, y: box.y + 12 });
    await waitFile(() => read().audio[0].start, 1.5);
    expect(read().audio[0]).toMatchObject({ in: 1, end: 4 });
    await expect.poll(async () => (await cueBand('music').boundingBox())!.x).toBeGreaterThan(box.x + 5 * px);
    await page.waitForTimeout(200);
    const after = (await cueBand('music').boundingBox())!;
    await drag({ x: after.x + after.width - 2, y: after.y + 12 }, { x: after.x + after.width - 2 - 6 * px, y: after.y + 12 });
    await waitFile(() => read().audio[0].end, 3.5);
  });

  it('sets a fade from its corner mark', async () => {
    const { px } = await perFrame();
    await cueBand('music').hover();
    const mark = (await page.locator('.fade-mark.is-in').boundingBox())!;
    await drag({ x: mark.x + 4, y: mark.y + 4 }, { x: mark.x + 4 + 6 * px, y: mark.y + 4 });
    await waitFile(() => read().audio[0].fadeIn, 0.5);
    await page.locator('.sound-fade.is-in').waitFor();
  });

  it('splits, duplicates and deletes the selected sound with the same keys', async () => {
    await cueBand('music').click({ position: { x: 40, y: 12 } });
    await seek(24);
    await page.keyboard.press('s');
    await waitFile(() => read().audio.map((c: { id: string }) => c.id), ['music', 'music-2']);
    expect(read().audio).toMatchObject([{ start: 1, end: 2, in: 0.5 }, { start: 2, end: 4, in: 1.5 }]);
    await expect.poll(() => cueBand('music-2').getAttribute('class')).toContain('is-selected');
    await page.keyboard.press('Meta+d');
    await waitFile(() => read().audio.map((c: { id: string }) => c.id), ['music', 'music-2', 'music-3']);
    await expect.poll(() => cueBand('music-3').getAttribute('class')).toContain('is-selected');
    await page.keyboard.press('Delete');
    await waitFile(() => read().audio.map((c: { id: string }) => c.id), ['music', 'music-2']);
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio.map((c: { id: string }) => c.id), ['music']);
  });

  it('keeps a split file sounding the same', async () => {
    const worker = await renderClient(server, 'cut');
    const before = await worker.call('audioHash');
    await cueBand('music').click({ position: { x: 40, y: 12 } });
    await seek(24);
    await page.keyboard.press('s');
    await waitFile(() => read().audio.length, 2);
    const after = await renderClient(server, 'cut');
    expect(await after.call('audioHash')).toBe(before);
  });

  it('keeps an anchored key at its word\'s last time when the voice goes', async () => {
    writeFileSync(
      join(folder, 'compositions/cut.json'),
      JSON.stringify({ ...COMPOSITION, markers: [{ t: 1.2, label: 'said', word: 'voice#w0' }], audio: [{ id: 'voice', file: 'media/tone.wav', start: 1, end: 3, words: [{ id: 'w0', text: 'hello', start: 0.2, end: 0.6 }] }] }),
    );
    await page.locator('.voice-row').waitFor();
    await page.locator('.voice-row').hover();
    const { px } = await perFrame();
    const grip = (await page.locator('.voice-grip').boundingBox())!;
    await drag({ x: grip.x + 4, y: grip.y + 8 }, { x: grip.x + 4 + 24 * px, y: grip.y + 8 });
    await waitFile(() => read().audio[0].start, 3);
    await page.waitForTimeout(300);
    const row = (await page.locator('.voice-row').boundingBox())!;
    await page.mouse.click(row.x + row.width - 30, row.y + 4, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await waitFile(() => read().audio, undefined);
    expect(read().markers[0].t).toBeCloseTo(3.2, 6);
  });

  it('moves a voice into a scene of its own, with captions, as one undo step', async () => {
    const words = [{ id: 'w0', text: 'hello', start: 0.6, end: 1 }, { id: 'w1', text: 'there', start: 1.2, end: 1.6 }];
    writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify({ ...COMPOSITION, audio: [{ id: 'voice', file: 'media/tone.wav', start: 1, end: 3, in: 0.5, words }] }));
    await page.locator('.voice-row').waitFor();
    const row = (await page.locator('.voice-row').boundingBox())!;
    await page.mouse.click(row.x + row.width - 30, row.y + 4, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to a voice scene' }).click();
    await waitFile(() => read().tracks.length, 3);
    expect(read().audio).toBeUndefined();
    expect(read().tracks[2].clips).toEqual([{ id: 'cut-voice', scene: 'cut-voice', start: 1 }]);
    const made = read('scenes/cut-voice.json');
    expect(made).toMatchObject({ duration: 2, fps: 12, size: [640, 360], layers: [{ rig: 'captions', params: { cue: 'voice' } }], audio: [{ id: 'voice', start: 0, end: 2, in: 0.5, words }] });
    expect(made.background).toBeUndefined();
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio?.[0]?.id, 'voice');
    expect(read().tracks).toHaveLength(2);
    rmSync(join(folder, 'scenes/cut-voice.json'));
  });
});

describe('sound on a scene', () => {
  it('moves and trims a voice by its grip and ends, with its words', async () => {
    writeFileSync(
      join(folder, 'scenes/spoken.json'),
      JSON.stringify({ ...scene('spoken', '#f4efe6', 80), duration: 8, audio: [{ id: 'voice', file: 'media/tone.wav', start: 1, end: 5, in: 0, words: [{ id: 'w0', text: 'hello', start: 0.5, end: 1 }] }] }),
    );
    const spoken = () => read('scenes/spoken.json').audio[0];
    await page.goto(server.paired('?scene=spoken'));
    await page.locator('.voice-row').waitFor();
    const { px } = await perFrame();
    const chipBefore = (await page.locator('.word-chip').boundingBox())!;
    await page.locator('.voice-row').hover();
    const grip = (await page.locator('.voice-grip').boundingBox())!;
    await drag({ x: grip.x + 4, y: grip.y + 8 }, { x: grip.x + 4 + 12 * px, y: grip.y + 8 });
    await waitFile(() => spoken().start, 2);
    expect(spoken()).toMatchObject({ end: 6, words: [{ start: 0.5, end: 1 }] });
    await expect.poll(async () => (await page.locator('.word-chip').boundingBox())!.x).toBeCloseTo(chipBefore.x + 12 * px, 0);
    await page.keyboard.press('Meta+z');
    await waitFile(() => spoken().start, 1);
    await expect.poll(async () => (await page.locator('.word-chip').boundingBox())!.x, { timeout: 4000 }).toBeCloseTo(chipBefore.x, 0);
    await page.waitForTimeout(300);
    const row = (await page.locator('.voice-row').boundingBox())!;
    await page.locator('.voice-row').hover();
    await drag({ x: row.x + row.width - 2, y: row.y + 8 }, { x: row.x + row.width - 2 - 12 * px, y: row.y + 8 });
    await waitFile(() => spoken().end, 4);
    rmSync(join(folder, 'scenes/spoken.json'));
  });

  it('offers no clip tools on a scene', async () => {
    await page.goto(server.paired('?scene=a'));
    await page.locator('.tl-row').first().waitFor();
    expect(await page.getByRole('button', { name: 'Clip', exact: true }).count()).toBe(0);
    await page.keyboard.press('s');
    await expect.poll(() => page.locator('.sel-notice').textContent()).toMatch(/Select a clip or sound/);
  });
});

describe('history', () => {
  it('ends when someone else changes the file, and survives its own saves', async () => {
    await select('two');
    await page.keyboard.press('Meta+d');
    await waitFile(() => clips().length, 3);
    await page.waitForTimeout(400);
    const file = read();
    file.background = '#202020';
    writeFileSync(join(folder, 'compositions/cut.json'), JSON.stringify(file));
    await expect.poll(() => page.evaluate(() => (window as unknown as { studio: { scene: { background?: { params: { color: string } } } } }).studio.scene.background?.params.color)).toBe('#202020');
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(400);
    expect(clips()).toHaveLength(3);
  });

  it('takes back a sound placed from the Library', async () => {
    await page.getByRole('list', { name: 'Projects' }).locator('.project-row').first().click();
    await page.getByRole('button', { name: 'Add tone.wav at the playhead' }).click();
    await waitFile(() => read().audio.length, 2);
    await cueBand('tone').waitFor();
    await page.keyboard.press('Meta+z');
    await waitFile(() => read().audio.length, 1);
  });
});
