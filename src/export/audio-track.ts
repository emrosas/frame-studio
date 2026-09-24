// Finishes the audio track Mediabunny wrote, so it plays on time and ends with
// the video in ffmpeg, Chromium and AVFoundation alike (ticket 14, "Priming
// decides audio sync").
//
// - It trims the audio to the video's length with the edit list, so the
//   encoder's padding at the end doesn't make the file longer than its frames.
//   Mediabunny writes an edit list only when packets start before 0, which the
//   exporter does for AAC; for Opus this adds one.
// - For AAC it adds what Mediabunny leaves out: a `roll` sample group. The
//   exporter shifts AAC packets back by the priming, so the edit list skips it,
//   and without the roll group AVFoundation skips the priming a second time and
//   plays early.
//
// It works on the moov and the header of the `free` box after it, which
// Mediabunny's fastStart 'reserve' writes in front of mdat and reports through
// onMoov. The moov grows into the free space, so mdat and every chunk offset
// stay put. Pure, so it is unit tested without a browser.

/** A box whose children we edit, or a leaf kept as bytes (header included). */
type Box = { type: string; children: Box[] } | { type: string; bytes: Uint8Array };

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The boxes in bytes[start, end), each with its offset and total size. */
function scan(bytes: Uint8Array, start: number, end: number): { type: string; at: number; size: number }[] {
  const out: { type: string; at: number; size: number }[] = [];
  const v = view(bytes);
  let at = start;
  while (at < end) {
    if (end - at < 8) throw new Error(`truncated box header at byte ${at}`);
    let size = v.getUint32(at);
    const type = fourcc(bytes, at + 4);
    if (size === 1) size = Number(v.getBigUint64(at + 8));
    else if (size === 0) size = end - at;
    if (size < 8 || at + size > end) throw new Error(`box "${type}" at byte ${at} has a bad size (${size})`);
    out.push({ type, at, size });
    at += size;
  }
  return out;
}

function parse(bytes: Uint8Array, at: number, size: number, type: string): Box {
  if (!CONTAINERS.has(type)) return { type, bytes: bytes.slice(at, at + size) };
  const header = view(bytes).getUint32(at) === 1 ? 16 : 8;
  return { type, children: scan(bytes, at + header, at + size).map((b) => parse(bytes, b.at, b.size, b.type)) };
}

function sizeOf(box: Box): number {
  return 'bytes' in box ? box.bytes.length : 8 + box.children.reduce((sum, c) => sum + sizeOf(c), 0);
}

function write(box: Box, out: Uint8Array, at: number): number {
  if ('bytes' in box) {
    out.set(box.bytes, at);
    return at + box.bytes.length;
  }
  const size = sizeOf(box);
  view(out).setUint32(at, size);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = box.type.charCodeAt(i);
  let next = at + 8;
  for (const child of box.children) next = write(child, out, next);
  return next;
}

function child(box: Box | undefined, type: string): Box | undefined {
  return box && 'children' in box ? box.children.find((c) => c.type === type) : undefined;
}

function leaf(box: Box | undefined, type: string): Uint8Array | undefined {
  const found = child(box, type);
  return found && 'bytes' in found ? found.bytes : undefined;
}

function fullBox(type: string, version: number, body: number[]): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  view(out).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out[8] = version;
  out.set(body, 12);
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An edts holding one edit: `duration` of the media from `mediaTime`, in the movie's and track's timescales. */
function editBox(duration: number, mediaTime: number): Box {
  const elst = fullBox('elst', 0, [...u32(1), ...u32(duration), ...u32(mediaTime), ...u32(0x10000)]);
  return { type: 'edts', children: [{ type: 'elst', bytes: elst }] };
}

/** sgpd and sbgp that put every one of `samples` AAC samples in a roll group with distance -1, as ffmpeg writes them. */
export function rollGroupBoxes(samples: number): Uint8Array[] {
  const sgpd = fullBox('sgpd', 1, [...ascii('roll'), ...u32(2), ...u32(1), 0xff, 0xff]);
  const sbgp = fullBox('sbgp', 0, [...ascii('roll'), ...u32(1), ...u32(samples), ...u32(1)]);
  return [sgpd, sbgp];
}

/** Offset of the duration field in an mvhd or tkhd, by version. */
function durationField(bytes: Uint8Array, type: 'mvhd' | 'tkhd'): { at: number; wide: boolean } {
  const wide = bytes[8] === 1;
  if (type === 'mvhd') return { at: wide ? 32 : 24, wide };
  return { at: wide ? 36 : 28, wide };
}

function readDuration(bytes: Uint8Array, type: 'mvhd' | 'tkhd'): number {
  const { at, wide } = durationField(bytes, type);
  return wide ? Number(view(bytes).getBigUint64(at)) : view(bytes).getUint32(at);
}

function writeDuration(bytes: Uint8Array, type: 'mvhd' | 'tkhd', value: number): void {
  const { at, wide } = durationField(bytes, type);
  if (wide) view(bytes).setBigUint64(at, BigInt(value));
  else view(bytes).setUint32(at, value);
}

export interface AudioTrackPatch {
  /** Video frames in the file and their rate, for the length the audio is trimmed to. */
  frames: number;
  fps: number;
  /** Add the AAC roll group. */
  roll: boolean;
}

/**
 * Takes the bytes Mediabunny reports through onMoov (the moov, then the
 * header of the free box that fills the rest of the reserved space) and
 * returns the patched moov and a new free header, to write at the same
 * position. The free box shrinks by what the moov grew.
 */
export function finishAudioTrack(region: Uint8Array, patch: AudioTrackPatch): Uint8Array {
  const type = region.length >= 8 ? fourcc(region, 4) : 'nothing';
  if (type !== 'moov') throw new Error(`expected the moov box first, found "${type}"`);
  const moovSize = view(region).getUint32(0);
  const freeType = region.length >= moovSize + 8 ? fourcc(region, moovSize + 4) : '';
  if (freeType !== 'free' && freeType !== 'skip') throw new Error('expected a free box after the moov box, to grow into');
  const reserved = moovSize + view(region).getUint32(moovSize);
  const moov = parse(region, 0, moovSize, 'moov');
  if (!('children' in moov)) throw new Error('unreachable');

  const mvhd = leaf(moov, 'mvhd');
  if (!mvhd) throw new Error('the moov box has no mvhd');
  const timescale = view(mvhd).getUint32(mvhd[8] === 1 ? 28 : 20);
  const length = Math.round((patch.frames * timescale) / patch.fps);

  const traks = moov.children.filter((c) => c.type === 'trak');
  const sound = traks.find((t) => {
    const hdlr = leaf(child(t, 'mdia'), 'hdlr');
    return hdlr !== undefined && fourcc(hdlr, 16) === 'soun';
  });
  if (!sound) throw new Error('the file has no audio track');

  // Trim the edit list and the track to the video's length, adding an edit list if there is none.
  const elst = leaf(child(sound, 'edts'), 'elst');
  if (!elst) {
    if (!('children' in sound)) throw new Error('unreachable');
    const at = sound.children.findIndex((c) => c.type === 'tkhd');
    sound.children.splice(at + 1, 0, editBox(length, 0));
  } else {
    if (view(elst).getUint32(12) !== 1) throw new Error('expected one edit in the audio edit list');
    if (elst[8] === 1) view(elst).setBigUint64(16, BigInt(Math.min(Number(view(elst).getBigUint64(16)), length)));
    else view(elst).setUint32(16, Math.min(view(elst).getUint32(16), length));
  }
  const tkhd = leaf(sound, 'tkhd');
  if (!tkhd) throw new Error('the audio track has no tkhd');
  writeDuration(tkhd, 'tkhd', Math.min(readDuration(tkhd, 'tkhd'), length));
  const longest = Math.max(
    ...traks.map((t) => {
      const header = leaf(t, 'tkhd');
      return header ? readDuration(header, 'tkhd') : 0;
    }),
  );
  writeDuration(mvhd, 'mvhd', longest);

  // Add the roll group for AAC, unless the muxer already wrote one.
  const stbl = child(child(child(sound, 'mdia'), 'minf'), 'stbl');
  if (!stbl || !('children' in stbl)) throw new Error('the audio track has no sample table');
  const hasRoll = stbl.children.some((c) => c.type === 'sgpd' && 'bytes' in c && fourcc(c.bytes, 12) === 'roll');
  if (patch.roll && !hasRoll) {
    const stsz = leaf(stbl, 'stsz');
    if (!stsz) throw new Error('the audio sample table has no stsz');
    const samples = view(stsz).getUint32(16);
    for (const bytes of rollGroupBoxes(samples)) stbl.children.push({ type: fourcc(bytes, 4), bytes });
  }

  const grown = sizeOf(moov);
  const free = reserved - grown;
  if (free < 8) throw new Error(`no room to grow the moov box: it needs ${grown} bytes of the ${reserved} reserved`);
  const out = new Uint8Array(grown + 8);
  const end = write(moov, out, 0);
  view(out).setUint32(end, free);
  out.set(ascii('free'), end + 4);
  return out;
}
