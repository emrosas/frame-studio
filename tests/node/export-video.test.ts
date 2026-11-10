import type { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { packRecord, type PacketRecord } from '../../src/export/packets';
import { muxSegment, readAudio } from '../../tools/studio/export-video';

const file = (records: PacketRecord[]) => {
  const parts = records.map(packRecord);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const config = (avcc = [1, 100, 0, 40]): PacketRecord => ({ kind: 'video-config', codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, data: new Uint8Array(avcc) });
const frames = (from: number, count: number, fpsUs = 83_333): PacketRecord[] =>
  Array.from({ length: count }, (_, i) => ({ kind: 'video', key: i === 0, timestamp: (from + i) * fpsUs, duration: fpsUs, data: new Uint8Array([from + i]) }));

function recorder() {
  const added: { timestamp: number; key: boolean; data: number; config: boolean }[] = [];
  return {
    added,
    async addVideo(packet: EncodedPacket, decoderConfig?: VideoDecoderConfig) {
      added.push({ timestamp: packet.timestamp, key: packet.type === 'key', data: packet.data[0], config: decoderConfig !== undefined });
    },
  };
}

describe('muxing the segments of a parallel export', () => {
  it('adds the packets of each segment in order, with the decoder config only on the very first', async () => {
    const muxer = recorder();
    let reference = await muxSegment(muxer, file([config(), ...frames(0, 3)]), 0, null);
    reference = await muxSegment(muxer, file([config(), ...frames(3, 3)]), 1, reference);
    expect(muxer.added.map((p) => p.data)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(muxer.added.map((p) => p.config)).toEqual([true, false, false, false, false, false]);
    expect(muxer.added.map((p) => p.key)).toEqual([true, false, false, true, false, false]);
    // Whole microseconds over 1e6, as EncodedPacket.fromEncodedChunk makes them in the page.
    expect(muxer.added[4].timestamp).toBe((4 * 83_333) / 1e6);
    expect(reference.codec).toBe('avc1.640028');
  });

  it('refuses a segment whose encoder wrote another SPS/PPS', async () => {
    const muxer = recorder();
    const reference = await muxSegment(muxer, file([config(), ...frames(0, 2)]), 0, null);
    await expect(muxSegment(muxer, file([config([1, 77, 0, 40]), ...frames(2, 2)]), 1, reference)).rejects.toThrow(/different SPS\/PPS/);
  });

  it('refuses a segment that does not open on a key frame, or has no config', async () => {
    const muxer = recorder();
    const late = frames(0, 2).map((r) => ({ ...r, key: false }));
    await expect(muxSegment(muxer, file([config(), ...late]), 0, null)).rejects.toThrow(/key frame/);
    await expect(muxSegment(recorder(), file(frames(0, 2)), 0, null)).rejects.toThrow(/no decoder config/);
  });

  it('reads the sound back to the same timestamps the page gave the muxer', () => {
    const audio = readAudio(
      file([
        { kind: 'audio-config', codec: 'aac', codecString: 'mp4a.40.2', configCodec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, priming: 2112, data: new Uint8Array([0x11, 0x90]) },
        { kind: 'audio', key: true, start: -2112, length: 1024, data: new Uint8Array([1]) },
        { kind: 'audio', key: true, start: -1088, length: 1024, data: new Uint8Array([2]) },
      ]),
    );
    expect(audio.codec).toBe('aac');
    expect(audio.decoderConfig).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 });
    expect(audio.packets.map((p) => [p.timestamp, p.duration])).toEqual([
      [-2112 / 48_000, 1024 / 48_000],
      [-1088 / 48_000, 1024 / 48_000],
    ]);
  });
});
