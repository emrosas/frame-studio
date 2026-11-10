import { describe, expect, it } from 'vitest';
import { packRecord, RecordWriter, unpackRecords, type PacketRecord } from './packets';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('packet records', () => {
  it('round-trips every kind, data and integer times intact', () => {
    const records: PacketRecord[] = [
      { kind: 'video-config', codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, data: bytes(1, 100, 0, 40) },
      { kind: 'video', key: true, timestamp: 0, duration: 83_333, data: bytes(0, 0, 0, 1, 0x65) },
      { kind: 'video', key: false, timestamp: 899_999_967, duration: 33_333, data: bytes() },
      { kind: 'audio-config', codec: 'aac', codecString: 'mp4a.40.2', configCodec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, priming: 2112, data: bytes(0x11, 0x90) },
      { kind: 'audio', key: true, start: -2112, length: 1024, data: bytes(9, 9, 9) },
    ];
    const file = new Uint8Array(records.reduce((n, r) => n + packRecord(r).length, 0));
    let at = 0;
    for (const r of records) {
      const packed = packRecord(r);
      file.set(packed, at);
      at += packed.length;
    }
    expect([...unpackRecords(file)]).toEqual(records);
  });

  it('refuses a truncated file', () => {
    const packed = packRecord({ kind: 'video', key: true, timestamp: 0, duration: 1, data: bytes(1, 2, 3) });
    expect(() => [...unpackRecords(packed.subarray(0, packed.length - 1))]).toThrow(/truncated/);
    expect(() => [...unpackRecords(packed.subarray(0, 2))]).toThrow(/truncated/);
  });

  it('batches writes at increasing positions, in order', async () => {
    const writes: { position: number; length: number }[] = [];
    const out = new Uint8Array(4096);
    const writer = new RecordWriter((data, position) => {
      writes.push({ position, length: data.length });
      out.set(data, position);
    }, 100);
    const records: PacketRecord[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'video', key: i === 0, timestamp: i * 1000, duration: 1000, data: new Uint8Array(30).fill(i) }));
    for (const r of records) await writer.add(r);
    await writer.flush();
    expect(writes.length).toBeGreaterThan(1);
    for (const [i, w] of writes.entries()) if (i > 0) expect(w.position).toBe(writes[i - 1].position + writes[i - 1].length);
    const end = writes.at(-1)!.position + writes.at(-1)!.length;
    expect([...unpackRecords(out.subarray(0, end))]).toEqual(records);
  });
});
