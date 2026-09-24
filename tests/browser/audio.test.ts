/**
 * M7 in a real browser: the render page renders scenes/audio-test.json's
 * audio with OfflineAudioContext and exports it into the MP4.
 *
 * - The same scene renders identical audio in two browser launches.
 * - No input in the graph gets more than two connections (ticket 04: Chromium
 *   sums three or more in an order that changes run to run).
 * - Blips land within one frame of their frame in the exported MP4, decoded
 *   by ffmpeg, for the whole scene and for a range.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, openStudio, type Studio } from '../../tools/render/studio';

const SCENE = 'audio-test'; // 30 fps; blips at 0.5, 1.0 and 1.5 s, then a buzz and a pad from 2 s
const SPF = 48000 / 30;
const BLIPS = [0.5, 1, 1.5].map((t) => t * 48000);

let browser: Browser;
let studio: Studio;
let dir: string;

beforeAll(async () => {
  browser = await launchBrowser();
  studio = await openStudio(SCENE, { browser });
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-audio-'));
});

afterAll(async () => {
  await studio?.close();
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The file's audio as ffmpeg decodes it: mono float samples at 48 kHz. */
function decodeAudio(path: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/** The first sample at or after `from` louder than a quiet threshold. */
function onsetAfter(samples: Float32Array, from: number): number {
  for (let i = Math.max(0, from); i < samples.length; i++) if (Math.abs(samples[i]) > 0.05) return i;
  return -1;
}

describe('audio determinism', () => {
  it('renders identical audio in a second browser launch', async () => {
    await studio.load(SCENE);
    const first = await studio.call('audioHash');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const other = await openStudio(SCENE);
    try {
      expect(await other.call('audioHash')).toBe(first);
    } finally {
      await other.close();
    }
  });

  it('never connects more than two nodes into one input', async () => {
    await studio.page.addInitScript(() => {
      const counts = new Map<unknown, Map<number, number>>();
      let max = 0;
      const wrap = (proto: { connect: (...a: unknown[]) => unknown }) => {
        const connect = proto.connect;
        proto.connect = function (this: unknown, ...args: unknown[]) {
          const [destination, , input = 0] = args as [unknown, number?, number?];
          const inputs = counts.get(destination) ?? new Map<number, number>();
          counts.set(destination, inputs);
          const n = (inputs.get(input) ?? 0) + 1;
          inputs.set(input, n);
          max = Math.max(max, n);
          return connect.apply(this, args);
        };
      };
      wrap(AudioNode.prototype as unknown as { connect: (...a: unknown[]) => unknown });
      (window as unknown as { __maxFanIn: () => number }).__maxFanIn = () => max;
    });
    await studio.load(SCENE);
    await studio.call('audioHash');
    const max = await studio.page.evaluate(() => (window as unknown as { __maxFanIn: () => number }).__maxFanIn());
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(2);
  });

  it('reports a silent scene as silent', async () => {
    const scene = await studio.load('hello');
    expect(scene.audio).toBe(false);
    expect(await studio.call('audioHash')).toBeNull();
  });
});

describe('MP4 audio', () => {
  async function exportMp4(name: string, options?: { from?: number; to?: number; audioCodec?: 'aac' | 'opus' }) {
    const path = join(dir, name);
    const result = await studio.call('exportVideo', 'mp4', await studio.fileSink(path), options);
    const input = new Input({ source: new BufferSource(readFileSync(path)), formats: ALL_FORMATS });
    return { path, result, input };
  }

  it('adds an AAC or Opus track exactly as long as the video', async () => {
    await studio.load(SCENE);
    const { result, input } = await exportMp4('whole.mp4');
    expect(result).toMatchObject({ frames: 120, seconds: 4 });
    expect(['mp4a.40.2', 'opus']).toContain(result.audioCodec);
    const audio = await input.getPrimaryAudioTrack();
    expect(audio?.codec).toBe(result.audioCodec === 'opus' ? 'opus' : 'aac');
    expect([audio?.sampleRate, audio?.numberOfChannels]).toEqual([48000, 2]);
  });

  it.skipIf(!hasFfmpeg())('trims the audio to the video length (read by ffprobe, dev only)', async () => {
    // Mediabunny's reader measures packets and ignores the edit list, so this asks ffprobe.
    await studio.load(SCENE);
    const { path } = await exportMp4('length.mp4');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'csv=p=0', path]).toString();
    expect(probe.trim().split('\n').sort()).toEqual(['4.000000', 'audio,4.000000', 'video,4.000000']);
  });

  it('leaves a silent scene silent', async () => {
    await studio.load('hello');
    const { result, input } = await exportMp4('silent.mp4', { from: 0, to: 12 });
    expect(result.audioCodec).toBeUndefined();
    expect(await input.getPrimaryAudioTrack()).toBeNull();
  });

  it.skipIf(!hasFfmpeg())('puts each blip within one frame of its frame (decoded by ffmpeg, dev only)', async () => {
    await studio.load(SCENE);
    const { path } = await exportMp4('aligned.mp4');
    const samples = decodeAudio(path);
    // Quiet until the first blip, apart from a little codec pre-echo just before it.
    expect(Math.max(...samples.subarray(0, BLIPS[0] - 2000).map(Math.abs))).toBeLessThan(0.01);
    for (const expected of BLIPS) {
      const onset = onsetAfter(samples, expected - SPF);
      expect(onset - expected, `blip at sample ${expected}`).toBeGreaterThanOrEqual(0);
      expect(onset - expected, `blip at sample ${expected}`).toBeLessThan(SPF);
    }
  });

  it.skipIf(!hasFfmpeg())('starts a range export with the audio at the range start (dev only)', async () => {
    await studio.load(SCENE);
    const { path, result } = await exportMp4('range.mp4', { from: 30, to: 60 });
    expect(result).toMatchObject({ frames: 30, seconds: 1 });
    const samples = decodeAudio(path);
    // The range starts on the 1.0 s blip; the 1.5 s one lands at 0.5 s.
    for (const expected of [0, 24000]) {
      const onset = onsetAfter(samples, expected - SPF);
      expect(onset - expected, `blip at sample ${expected}`).toBeGreaterThanOrEqual(0);
      expect(onset - expected, `blip at sample ${expected}`).toBeLessThan(SPF);
    }
  });

  it.skipIf(!hasFfmpeg())('trims and aligns the Opus fallback too (read by ffmpeg, dev only)', async () => {
    // Linux Chromium and Firefox have no AAC encoder, so this forces the path they take.
    await studio.load(SCENE);
    const { path, result } = await exportMp4('opus.mp4', { audioCodec: 'opus' });
    expect(result.audioCodec).toBe('opus');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'csv=p=0', path]).toString();
    expect(probe.trim().split('\n').sort()).toEqual(['4.000000', 'audio,4.000000', 'video,4.000000']);
    const samples = decodeAudio(path);
    for (const expected of BLIPS) {
      const onset = onsetAfter(samples, expected - SPF);
      expect(onset - expected, `blip at sample ${expected}`).toBeGreaterThanOrEqual(0);
      expect(onset - expected, `blip at sample ${expected}`).toBeLessThan(SPF);
    }
  });
});
