/**
 * M3 in a real browser: render.html in Playwright's headless Chromium, driven
 * through tools/render/studio.ts like the CLI.
 *
 * - Determinism: every frame of every scene hashes the same whether drawn in
 *   order from frame 0 or seeked to directly in a fresh page.
 * - Ticket 03 on the pinned build: CPU canvas raster, PNG output that decodes
 *   to exactly the canvas bytes, and identical pixels across launches.
 * - Exports: MP4 and GIF with exactly the frames and duration asked for.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGifStructure } from '../../src/export/testing/gif-structure';
import { launchBrowser, openStudio, ROOT, type Studio } from '../../tools/render/studio';

const SCENES = readdirSync(join(ROOT, 'scenes'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length))
  .sort();

let browser: Browser;
let studio: Studio;
let dir: string;

beforeAll(async () => {
  browser = await launchBrowser();
  studio = await openStudio('bear-test', { browser });
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-render-'));
});

afterAll(async () => {
  await studio?.close();
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function hashes(frames: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const f of frames) out.set(f, await studio.call('pixelHash', f));
  return out;
}

/** SHA-256 of the RGBA pixels a PNG decodes to. */
async function pngPixelHash(path: string): Promise<string> {
  const image = await loadImage(readFileSync(path));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return createHash('sha256').update(ctx.getImageData(0, 0, image.width, image.height).data).digest('hex');
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('determinism: seeking to frame N draws the same pixels as playing from frame 0', () => {
  it.each(SCENES)('%s', async (key) => {
    const scene = await studio.load(key);
    const all = Array.from({ length: scene.frameCount }, (_, f) => f);
    const played = await hashes(all);
    // A fresh page, then frames out of order: backwards, then every seventh.
    await studio.load(key);
    const seekOrder = [...all].reverse().concat(all.filter((f) => f % 7 === 3));
    const seeked = await hashes(seekOrder);
    const mismatches = seekOrder.filter((f) => seeked.get(f) !== played.get(f));
    expect(mismatches, `frames that differ in ${key}`).toEqual([]);
    if (scene.frameCount > 1) expect(new Set(played.values()).size, `${key} is not one still image`).toBeGreaterThan(1);
  });
});

describe('ticket 03 checks on the pinned Chromium', () => {
  it('rasterizes 2D canvas on the CPU', async () => {
    const cdp = await browser.newBrowserCDPSession();
    const info = (await cdp.send('SystemInfo.getInfo')) as { gpu: { featureStatus: Record<string, string> } };
    await cdp.detach();
    expect(info.gpu.featureStatus['2d_canvas']).toMatch(/_software$|^disabled/);
  });

  it('writes PNGs that decode to exactly the canvas pixels', async () => {
    await studio.load('bear-test');
    for (const frame of [0, 47, 60]) {
      const path = join(dir, `frame-${frame}.png`);
      await studio.call('writePng', frame, await studio.fileSink(path));
      expect(await pngPixelHash(path), `frame ${frame}`).toBe(await studio.call('pixelHash', frame));
    }
  });

  it('draws identical pixels in a second browser launch', async () => {
    await studio.load('bear-test');
    const frames = [0, 12, 47, 60, 95];
    const first = await hashes(frames);
    const other = await openStudio('bear-test');
    try {
      for (const f of frames) expect(await other.call('pixelHash', f), `frame ${f}`).toBe(first.get(f));
    } finally {
      await other.close();
    }
  });
});

describe('MP4 export', () => {
  async function exportMp4(name: string, range?: { from?: number; to?: number }) {
    const path = join(dir, name);
    const result = await studio.call('exportVideo', 'mp4', await studio.fileSink(path), range);
    const input = new Input({ source: new BufferSource(readFileSync(path)), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${name} has no video track`);
    return { path, result, input, track };
  }

  it('writes H.264 with one packet per frame, lasting exactly frameCount / fps', async () => {
    const scene = await studio.load('bear-test');
    const { result, input, track } = await exportMp4('bear-test.mp4');
    expect(result).toMatchObject({ target: 'mp4', from: 0, to: 96, frames: 96, seconds: 8, codec: 'avc1.640028' });
    expect(track.codec).toBe('avc');
    expect([track.displayWidth, track.displayHeight]).toEqual([scene.width, scene.height]);
    expect((await track.computePacketStats()).packetCount).toBe(96);
    expect(await input.computeDuration()).toBeCloseTo(8, 6);
    // Ticket 15: BT.709 primaries, sRGB transfer, BT.709 matrix, full range.
    expect(await track.getColorSpace()).toEqual({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true });
  });

  it('exports a range from 0 s, lasting exactly its frames', async () => {
    await studio.load('bear-test');
    const { result, input, track } = await exportMp4('range.mp4', { from: 12, to: 36 });
    expect(result).toMatchObject({ from: 12, to: 36, frames: 24, seconds: 2 });
    expect((await track.computePacketStats()).packetCount).toBe(24);
    expect(await track.getFirstTimestamp()).toBe(0);
    expect(await input.computeDuration()).toBeCloseTo(2, 6);
  });

  it.skipIf(!hasFfmpeg())('decodes to the rendered frames, in order (checked with ffmpeg, dev only)', async () => {
    await studio.load('bear-test');
    const { path } = await exportMp4('order.mp4');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', path]).toString().trim();
    expect(probe).toBe('12/1,96');
    for (const frame of [0, 47, 60, 95]) {
      const png = join(dir, `decoded-${frame}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', png]);
      const decoded = (await loadImage(readFileSync(png)));
      const c = createCanvas(decoded.width, decoded.height);
      c.getContext('2d').drawImage(decoded, 0, 0);
      const got = c.getContext('2d').getImageData(0, 0, decoded.width, decoded.height).data;
      const reference = join(dir, `reference-${frame}.png`);
      await studio.call('writePng', frame, await studio.fileSink(reference));
      const ref = await loadImage(readFileSync(reference));
      const rc = createCanvas(ref.width, ref.height);
      rc.getContext('2d').drawImage(ref, 0, 0);
      const want = rc.getContext('2d').getImageData(0, 0, ref.width, ref.height).data;
      let sq = 0;
      for (let i = 0; i < want.length; i += 4) for (let ch = 0; ch < 3; ch++) sq += (got[i + ch] - want[i + ch]) ** 2;
      const psnr = 10 * Math.log10((255 * 255) / (sq / ((want.length / 4) * 3)));
      expect(psnr, `frame ${frame} PSNR`).toBeGreaterThan(35);
    }
  });
});

describe('MP4 colour (ticket 15, checked with ffmpeg, dev only)', () => {
  it.skipIf(!hasFfmpeg())('tags both the VUI and colr, and decodes the ground to the scene colour within 1 level', async () => {
    await studio.load('bear-test');
    const path = join(dir, 'colour.mp4');
    await studio.call('exportVideo', 'mp4', await studio.fileSink(path), { from: 0, to: 24 });
    // ffprobe reports what the decoder read, which is the SPS VUI.
    const vui = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space,color_primaries,color_transfer', '-of', 'csv=p=0', path]).toString().trim();
    expect(vui).toBe('pc,bt709,iec61966-2-1,bt709');
    // ffmpeg's trace log, on stderr, prints the colr box it parsed.
    const trace = spawnSync('ffmpeg', ['-v', 'trace', '-i', path, '-frames:v', '1', '-f', 'null', '-']).stderr.toString();
    expect(trace).toMatch(/nclx: pri 1 trc 13 matrix 1 full 1/);
    // #ffa200 ground, 32x32 at (1732, 92) on frame 12, averaged.
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'select=eq(n\\,12),crop=32:32:1732:92,scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const [r, g, b] = [...rgb];
    for (const [got, want] of [[r, 255], [g, 162], [b, 0]]) expect(Math.abs(got - want), `ground ${r},${g},${b}`).toBeLessThanOrEqual(1);
  });
});

describe('GIF export', () => {
  it('writes one frame per scene frame, looping, with delays adding up to the duration', async () => {
    await studio.load('bear-test');
    const path = join(dir, 'bear-test.gif');
    const result = await studio.call('exportVideo', 'gif', await studio.fileSink(path));
    expect(result).toMatchObject({ target: 'gif', frames: 96, seconds: 8 });
    const gif = readGifStructure(readFileSync(path));
    expect(gif).toMatchObject({ width: 1920, height: 1080, loops: 0 });
    expect(gif.frames).toHaveLength(96);
    expect(gif.frames.reduce((n, f) => n + f.delayCs, 0)).toBe(800);
  });
});

describe('contact sheet', () => {
  it('draws every Nth frame into one PNG with the layout it reports', async () => {
    await studio.load('bear-test');
    const path = join(dir, 'sheet.png');
    const sheet = await studio.call('contactSheet', await studio.fileSink(path), { every: 12 });
    expect(sheet.frames).toEqual([0, 12, 24, 36, 48, 60, 72, 84]);
    const image = await loadImage(readFileSync(path));
    expect([image.width, image.height]).toEqual([sheet.width, sheet.height]);
  });
});

describe('errors', () => {
  it('names the scenes that exist when asked for one that does not', async () => {
    await expect(studio.load('no-such-scene')).rejects.toThrow(/No scene "no-such-scene".*bear-test/s);
  });

  it('rejects frames outside the scene', async () => {
    await studio.load('bear-test');
    await expect(studio.call('renderFrame', 96)).rejects.toThrow(/\[0, 96\)/);
    await expect(studio.call('resolveFrame', '00:08:00')).rejects.toThrow(/\[0, 96\)/);
    expect(await studio.call('resolveFrame', '00:08:00', true)).toBe(96);
    expect(await studio.call('resolveFrame', '00:03:11')).toBe(47);
  });
});
