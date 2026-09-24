import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { finishAudioTrack, rollGroupBoxes } from './audio-track';

const SR = 48000;
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PRIMING = 2112;

/**
 * An AAC-only MP4 muxed by Mediabunny the way the exporter muxes it, with fake
 * packet bytes. With priming 0 the packets start at 0, as Opus packets do.
 */
async function muxAac(samples: number, priming = PRIMING): Promise<{ file: Uint8Array; moov: Uint8Array; moovAt: number; packets: number }> {
  let moov = new Uint8Array();
  let moovAt = -1;
  const packets = Math.ceil((samples + priming) / 1024) + 1;
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'reserve',
      onMoov: (data, position) => {
        moov = data.slice();
        moovAt = position;
      },
    }),
    target,
  });
  const source = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(source, { maximumPacketCount: packets });
  await output.start();
  for (let i = 0; i < packets; i++) {
    const packet = new EncodedPacket(new Uint8Array([i & 255, 1, 2, 3]), 'key', (i * 1024 - priming) / SR, 1024 / SR);
    await source.add(
      packet,
      i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } } : undefined,
    );
  }
  await output.finalize();
  return { file: new Uint8Array(target.buffer!), moov, moovAt, packets };
}

/** Top-level box types and offsets, plus a lookup for nested boxes by path. */
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): { type: string; at: number; size: number }[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = start; at < end; ) {
    const size = v.getUint32(at);
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), at, size });
    at += size;
  }
  return out;
}

function find(bytes: Uint8Array, path: string[], start = 0, end = bytes.length): { at: number; size: number } | undefined {
  const [head, ...tail] = path;
  for (const box of boxes(bytes, start, end)) {
    if (box.type !== head) continue;
    if (tail.length === 0) return box;
    const hit = find(bytes, tail, box.at + 8, box.at + box.size);
    if (hit) return hit;
  }
  return undefined;
}

describe('finishAudioTrack', () => {
  it('builds the roll group boxes ffmpeg writes for AAC', () => {
    const [sgpd, sbgp] = rollGroupBoxes(300);
    expect([...sgpd]).toEqual([0, 0, 0, 26, ...ascii('sgpd'), 1, 0, 0, 0, ...ascii('roll'), 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff]);
    expect([...sbgp]).toEqual([0, 0, 0, 28, ...ascii('sbgp'), 0, 0, 0, 0, ...ascii('roll'), 0, 0, 0, 1, 0, 0, 1, 44, 0, 0, 0, 1]);
  });

  it('adds the roll group and trims the audio to the video length, in place', async () => {
    const samples = 3 * SR; // 3 s of audio, as 90 frames at 30 fps
    const { file, moov, moovAt, packets } = await muxAac(samples);
    const before = boxes(file).map((b) => b.type);
    expect(before).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(file.subarray(moovAt, moovAt + moov.length)).toEqual(moov);

    // Mediabunny's edit list skips the priming but keeps the encoder's padding.
    const elstBefore = find(file, ['moov', 'trak', 'edts', 'elst'])!;
    const dv = new DataView(file.buffer);
    expect(dv.getInt32(elstBefore.at + 20)).toBe(PRIMING);
    expect(dv.getUint32(elstBefore.at + 16)).toBeGreaterThan(3 * 57600);

    const patched = finishAudioTrack(moov, { frames: 90, fps: 30, roll: true });
    expect(patched.length).toBe(moov.length + 26 + 28);
    const out = file.slice();
    out.set(patched, moovAt);
    const ov = new DataView(out.buffer);

    // The free box shrank by what the moov grew, so mdat did not move and the sizes still add up to the file.
    const layout = (bytes: Uint8Array) => boxes(bytes).map((b) => [b.type, b.type === 'mdat' ? b.at : 0]);
    expect(layout(out)).toEqual(layout(file));

    const sgpd = find(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'sgpd'])!;
    const sbgp = find(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'sbgp'])!;
    expect(sgpd.size).toBe(26);
    expect(ov.getInt16(sgpd.at + 24)).toBe(-1);
    expect(ov.getUint32(sbgp.at + 20)).toBe(packets);

    const elst = find(out, ['moov', 'trak', 'edts', 'elst'])!;
    expect(ov.getUint32(elst.at + 16)).toBe(3 * 57600);
    expect(ov.getInt32(elst.at + 20)).toBe(PRIMING);
    const tkhd = find(out, ['moov', 'trak', 'tkhd'])!;
    expect(ov.getUint32(tkhd.at + 28)).toBe(3 * 57600);
    const mvhd = find(out, ['moov', 'mvhd'])!;
    expect(ov.getUint32(mvhd.at + 24)).toBe(3 * 57600);
  });

  it('adds an edit list that trims the end when packets start at 0, and no roll group without roll', async () => {
    const { file, moov, moovAt } = await muxAac(3 * SR, 0);
    expect(find(file, ['moov', 'trak', 'edts'])).toBeUndefined();
    const out = file.slice();
    out.set(finishAudioTrack(moov, { frames: 90, fps: 30, roll: false }), moovAt);
    const ov = new DataView(out.buffer);
    const layout = (bytes: Uint8Array) => boxes(bytes).map((b) => [b.type, b.type === 'mdat' ? b.at : 0]);
    expect(layout(out)).toEqual(layout(file));
    const trak = boxes(out, find(out, ['moov', 'trak'])!.at + 8, find(out, ['moov', 'trak'])!.at + find(out, ['moov', 'trak'])!.size);
    expect(trak.map((b) => b.type).slice(0, 3)).toEqual(['tkhd', 'edts', 'mdia']);
    const elst = find(out, ['moov', 'trak', 'edts', 'elst'])!;
    expect([ov.getUint32(elst.at + 12), ov.getUint32(elst.at + 16), ov.getInt32(elst.at + 20), ov.getUint32(elst.at + 24)]).toEqual([1, 3 * 57600, 0, 0x10000]);
    expect(find(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'sgpd'])).toBeUndefined();
    expect(ov.getUint32(find(out, ['moov', 'mvhd'])!.at + 24)).toBe(3 * 57600);
  });

  it('adds the roll group once', async () => {
    const { moov } = await muxAac(SR);
    const once = finishAudioTrack(moov, { frames: 30, fps: 30, roll: true });
    const twice = finishAudioTrack(once, { frames: 30, fps: 30, roll: true });
    expect(twice).toEqual(once);
  });

  it('needs the free box after the moov', async () => {
    const { moov } = await muxAac(SR);
    const alone = moov.subarray(0, new DataView(moov.buffer, moov.byteOffset).getUint32(0));
    expect(() => finishAudioTrack(alone, { frames: 30, fps: 30, roll: true })).toThrow(/expected a free box after the moov/);
  });

  it('refuses to grow past the reserved space', async () => {
    const { moov } = await muxAac(SR);
    const tight = moov.slice();
    const v = new DataView(tight.buffer);
    v.setUint32(v.getUint32(0), 8 + 20); // a free box with room for 20 bytes, and the roll group needs 54
    expect(() => finishAudioTrack(tight, { frames: 30, fps: 30, roll: true })).toThrow(/no room to grow the moov/);
  });
});
