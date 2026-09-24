// MP4 colour: every export is tagged BT.709 primaries, the sRGB transfer curve
// and the BT.709 matrix at full range (H.273 code points 1, 13, 1, full), in
// both the SPS VUI and the colr box. AVFoundation reads colr, Chrome's
// on-screen video on macOS reads the VUI, and every decoder takes the range
// from the VUI. Ticket 15, research/mp4-colour-tags.md.
//
// VideoEncoderConfig has no colour member and a canvas-sourced VideoFrame
// ignores one, so frames are converted to I420 here and carry the colour
// space themselves. Pure, so it is unit tested without a browser.

export const EXPORT_COLOR_SPACE = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true } as const satisfies VideoColorSpaceInit;

const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;
const CU = 1 / (2 * (1 - KB));
const CV = 1 / (2 * (1 - KR));

const byte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * sRGB-encoded RGBA to I420 with the BT.709 matrix at full range: a Y plane,
 * then U and V planes at half width and height, each chroma sample the
 * average of a 2x2 block. Alpha is ignored. Width and height must be even.
 */
export function rgbaToI420(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  out = new Uint8Array((width * height * 3) / 2),
): Uint8Array {
  if (width % 2 !== 0 || height % 2 !== 0) throw new RangeError(`I420 needs an even width and height, got ${width}x${height}`);
  const chromaWidth = width >> 1;
  const uBase = width * height;
  const vBase = uBase + chromaWidth * (height >> 1);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let u = 0;
      let v = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (y + dy) * width + x + dx;
          const p = i * 4;
          const r = rgba[p];
          const b = rgba[p + 2];
          const luma = KR * r + KG * rgba[p + 1] + KB * b;
          out[i] = byte(luma);
          u += (b - luma) * CU;
          v += (r - luma) * CV;
        }
      }
      const c = (y >> 1) * chromaWidth + (x >> 1);
      out[uBase + c] = byte(128 + u / 4);
      out[vBase + c] = byte(128 + v / 4);
    }
  }
  return out;
}

/**
 * Throws when the encoder reports writing primaries, transfer or matrix other
 * than EXPORT_COLOR_SPACE, which would leave colr and the VUI disagreeing.
 * The reported range is not checked: VideoToolbox in Chromium 140 and 152
 * writes full range but reports limited. Nothing reported passes.
 */
export function checkEncoderColorSpace(reported: VideoColorSpaceInit | undefined): void {
  if (!reported) return;
  const { primaries, transfer, matrix } = EXPORT_COLOR_SPACE;
  if (reported.primaries !== primaries || reported.transfer !== transfer || reported.matrix !== matrix) {
    throw new Error(
      `The H.264 encoder wrote colour space ${JSON.stringify(reported)}, not ${primaries} / ${transfer} / ${matrix}, so the file's colours would be off. ` +
        `This browser's encoder ignores the frame's colour space.`,
    );
  }
}
