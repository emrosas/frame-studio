// Reads a GIF's block structure without decoding pixels: screen size, loop
// count and each frame's delay, disposal and transparency. Test-only.

export interface GifFrameInfo {
  delayCs: number;
  disposal: number;
  transparentIndex: number | null;
  left: number;
  top: number;
  width: number;
  height: number;
  localTable: boolean;
}

export interface GifStructure {
  width: number;
  height: number;
  globalTableSize: number;
  /** Netscape loop count: 0 loops forever. Null without the extension. */
  loops: number | null;
  frames: GifFrameInfo[];
}

export function readGifStructure(bytes: Uint8Array): GifStructure {
  const text = String.fromCharCode(...bytes.subarray(0, 6));
  if (text !== 'GIF89a' && text !== 'GIF87a') throw new Error(`not a GIF: header ${JSON.stringify(text)}`);
  let p = 6;
  const u16 = () => {
    const v = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return v;
  };
  const skipSubBlocks = () => {
    for (let n = bytes[p++]; n !== 0; n = bytes[p++]) p += n;
  };
  const width = u16();
  const height = u16();
  const flags = bytes[p++];
  p += 2; // background colour index, aspect ratio
  const globalTableSize = flags & 0x80 ? 2 << (flags & 7) : 0;
  p += globalTableSize * 3;

  let loops: number | null = null;
  const frames: GifFrameInfo[] = [];
  let pending: Pick<GifFrameInfo, 'delayCs' | 'disposal' | 'transparentIndex'> = { delayCs: 0, disposal: 0, transparentIndex: null };
  for (;;) {
    if (p >= bytes.length) throw new Error('GIF ends without a trailer');
    const block = bytes[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        p++; // block size, 4
        const packed = bytes[p++];
        const delayCs = u16();
        const index = bytes[p++];
        pending = { delayCs, disposal: (packed >> 2) & 7, transparentIndex: packed & 1 ? index : null };
        p++; // terminator
      } else if (label === 0xff) {
        const size = bytes[p++];
        const app = String.fromCharCode(...bytes.subarray(p, p + size));
        p += size;
        if (app === 'NETSCAPE2.0' && bytes[p] === 3) loops = bytes[p + 2] | (bytes[p + 3] << 8);
        skipSubBlocks();
      } else {
        skipSubBlocks();
      }
    } else if (block === 0x2c) {
      const left = u16();
      const top = u16();
      const w = u16();
      const h = u16();
      const imageFlags = bytes[p++];
      const localTable = (imageFlags & 0x80) !== 0;
      if (localTable) p += (2 << (imageFlags & 7)) * 3;
      p++; // LZW minimum code size
      skipSubBlocks();
      frames.push({ ...pending, left, top, width: w, height: h, localTable });
      pending = { delayCs: 0, disposal: 0, transparentIndex: null };
    } else {
      throw new Error(`unexpected GIF block 0x${block.toString(16)} at byte ${p - 1}`);
    }
  }
  return { width, height, globalTableSize, loops, frames };
}
