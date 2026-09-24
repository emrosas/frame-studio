# Which colour tags make an exported MP4 decode to the scene's exact colours everywhere?

Research for [issue 15](../issues/15-mp4-colour-tags.md), following ticket [14](../issues/14-export-encoding.md). Checked 2026-09-23 on an Apple M1 Pro with macOS 27.0. The encoders were Playwright 1.55.0's headless shell, which is Chromium 140.0.7339.16 and encodes H.264 only through VideoToolbox under `--enable-gpu`, Playwright 1.63.0's Chrome Headless Shell 153.0.8010.12 with OpenH264, and with VideoToolbox under `--enable-gpu`, and Electron 44.4.5 on Chromium 152.0.7977.130 with OpenH264 and VideoToolbox. Muxing used Mediabunny 1.59.1. The decoders were Homebrew ffmpeg 7.1.1, AVFoundation on macOS 27.0, Chrome Headless Shell 153 with and without a GPU, and Electron 44. I didn't test Windows, Firefox or the Safari app.

## Question

Ticket 14 found that WebCodecs H.264 files carry different `colr` tags depending on the Chromium build, and that AVFoundation shifts the `bear-test` ground `#ffa200` to about 250,172,0 unless the file is tagged BT.709 primaries, sRGB transfer and full range. The ticket asks which tags every export should carry, whether `VideoEncoder` can be told to write them, whether Mediabunny or a patch after muxing can set `colr` and the H.264 VUI without re-encoding, and why Chromium 153 tags differently from 152.

## Short answer

Tag every export with the H.273 code points 1, 13 and 1 for colour primaries, transfer characteristics and matrix coefficients, meaning BT.709 primaries, the IEC 61966-2-1 sRGB curve and the BT.709 matrix, and set the full-range flag. Both the `colr` box and the SPS VUI must say this, because AVFoundation reads primaries and transfer from `colr` while Chromium's on-screen path on macOS reads them from the VUI, and every decoder I tried takes the range from the VUI.

With those tags, nine test colours decoded within 1 level in ffmpeg and in every Chromium path, and within 2 levels in AVFoundation. The 2 is pure red and pure blue coming out at 253. `#ffa200` decoded as 255,162,0 in ffmpeg and AVFoundation and 254 or 255,162,0 in Chromium, whichever encoder made the file. Any file tagged transfer 1, 2, 6 or untagged gets Apple's BT.709 display curve in AVFoundation and in Chrome's on-screen video on macOS. That lifts mid-grey from 128 to 139 and `#ffa200` to 254,172,0. SMPTE 170M primaries, which Chromium 152 and older write for canvas frames, add a gamut conversion on top and turn `#ffa200` into 250,172,0.

`VideoEncoderConfig` has no colour member, and a canvas-sourced `VideoFrame` can't carry one. What works in every build I tried is to convert the canvas pixels to I420 ourselves and construct `new VideoFrame(i420, { format: 'I420', ..., colorSpace })`. OpenH264 in Chromium 152 and 153 and VideoToolbox in Chromium 140, 152 and 153 all copied that colour space into the VUI. Mediabunny writes `colr` from `meta.decoderConfig.colorSpace`, so M3 sets that field on the first packet. VideoToolbox in Chromium 140 and 152 reports a full-range frame as limited in that metadata even though its VUI says full, so M3 should write the colour space it asked for, not the one reported.

Full range rather than limited because Chromium's CPU video path, which runs when there is no GPU, clamps a libyuv coefficient for limited-range BT.709. That puts the blue channel of `#ffa200` at 8 and pure blue at 243. Full-range BT.709 has no clamp and decoded within 1 there.

Rewriting the VUI after muxing is possible. I did it in a 250-line Python script, and ffmpeg's `h264_metadata` filter does it too. I don't recommend it for M3. It needs a bit-level SPS parser and writer, and VideoToolbox repeats the SPS inside every key frame, so a rewrite changes sample sizes. Making the encoder write the right VUI in the first place is simpler.

Chromium 153 changed because of commit [22094ce89ddd](https://chromium.googlesource.com/chromium/src/+/22094ce89ddd3c752cc755da41ba43f65fe5f874), "Integrate new matrix based libyuv RGB to YUV functions", reviewed as [crrev.com/c/7821801](https://chromium-review.googlesource.com/c/chromium/src/+/7821801) under bug [467555325](https://issues.chromium.org/issues/467555325). Behind the default-on feature `AccurateVideoFrameConverterColorSpace`, it converts sRGB canvas frames with the BT.709 matrix at full range and tags them BT.709, sRGB, BT.709, full. Before it, Chromium always converted with BT.601 at limited range and tagged SMPTE 170M. Launching Chrome Headless Shell 153 with `--disable-features=AccurateVideoFrameConverterColorSpace` brought back 152's tags.

## Which tags decode exactly

### What each decoder does with the tags

- ffmpeg converts to RGB with the matrix and range only and ignores primaries and transfer. With no tags at all it assumes the BT.601 matrix, which turned BT.709 data's `#ffa200` into 245,164,7. Its H.264 decoder copies the VUI over whatever the `colr` box said ([h264_slice.c#L1107](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavcodec/h264_slice.c#L1107), [mov.c#L2032](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/libavformat/mov.c#L2032)).
- AVFoundation colour-manages. Apple's note on video colour says "the AV Foundation framework automatically applies color management to video on both input and output" and maps `nclc` tags to colour spaces such as "1-1-1 HD (Rec. 709)" and "6-1-6 SD (SMPTE-C)" ([TN2227](https://developer.apple.com/library/archive/technotes/tn2227/_index.html)). For the BT.709 transfer it doesn't use the sRGB curve. Chromium's source describes Apple's curve as "Apple's CoreVideo uses gamma=1.961" ([color_space.cc#L990](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/ui/gfx/color_space.cc#990)). Converted to sRGB, that lifts mid-tones by about 11 levels. CoreVideo has a constant for the sRGB curve, described in its header as "IEC 61966-2-1 sRGB or sYCC" ([kCVImageBufferTransferFunction_sRGB](https://developer.apple.com/documentation/corevideo/kcvimagebuffertransferfunction_srgb)). A file tagged with it maps straight to sRGB.
- Chromium's canvas path treats the BT.709, SMPTE 170M and sRGB transfers as one curve. The same Chromium comment says so: "use the same transfer function as sRGB, which will allow more optimization, and will more closely match other media players". Drawing a video into a canvas therefore came out within 2 levels for every transfer tag I tried, wherever the libyuv clamp below didn't apply.
- Chromium's on-screen video on macOS with a GPU behaved like AVFoundation. Chrome Headless Shell 153 with `--enable-gpu` showed a BT.709-tagged file at 254,172,0 and grey 139 in a screenshot, while the same file drawn into a canvas read 254,162,0. My reading of the source is that a VideoToolbox-decoded frame carries CoreVideo's `ITU_R_709_2` transfer attachment, and Chromium maps that string to its `BT709_APPLE` transfer, the first match in its table ([color_space_util.mm#L114](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/ui/gfx/mac/color_space_util.mm#114)). I didn't trace that path end to end.
- Chromium without a GPU converts video on the CPU with libyuv. libyuv's limited-range BT.709 table caps the blue coefficient: `#define UB 128 /* max(128, round(2.112 * 64)) */` unless the build defines `LIBYUV_UNLIMITED_DATA` or `LIBYUV_UNLIMITED_BT709` ([row_common.cc#L1646 at Chromium 153's libyuv](https://chromium.googlesource.com/libyuv/libyuv/+/26e56be0f984af3dae4d0c0ab7a0bac8ac20e1b0/source/row_common.cc#1646)). Chromium's libyuv `BUILD.gn` defines neither. The full-range BT.709 table uses 119 and isn't capped. Electron 44 with `--disable-gpu` showed the same error, so it isn't new in 153.

### Results by tag set

The first nine rows are one OpenH264 stream from Chrome Headless Shell 153, made from my own BT.709 limited-range I420 data and retagged in the `colr` box and the VUI without re-encoding. The two full-range rows use a second stream made the same way from full-range data. The last four rows are canvas-frame files from the three builds, as written or retagged. Cells give the worst channel error over nine patches, then the `#ffa200` patch, then the grey patch's level. A perfect 8-bit round trip through Y'CbCr is already 1 level off for some of these colours.

| Tags, P,T,M,full in both places | ffmpeg | AVFoundation | Chromium 153, no GPU | Chromium 153 GPU, canvas | Chromium 153 GPU, on screen | Electron 44 canvas |
| --- | --- | --- | --- | --- | --- | --- |
| 1,1,1,0 BT.709 limited | 1; 254,162,0; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,1,1,1 BT.709 full | 1; 255,162,0; 128 | 12; 255,172,0; 139 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,13,1,0 sRGB transfer, limited | 1; 254,162,0; 128 | 2; 254,162,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| 1,13,1,1 sRGB transfer, full | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Untagged, no `colr`, no VUI signal type | 22; 245,164,7; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,2,1,0 transfer unspecified | 1; 254,162,0; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 2,2,1,0 matrix only, as ticket 14's ffmpeg wrote | 1; 254,162,0; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,4,1,0 gamma 2.2 transfer | 1; 254,162,0; 128 | 20; 254,177,0; 146 | 12; 254,164,2; 129 | 2; 254,163,0; 129 | 2; 254,164,0; 129 | 2; 254,163,0; 129 |
| 6,13,1,0 SMPTE 170M primaries | 1; 254,162,0; 128 | 63; 249,163,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 63; 249,163,0; 128 | 1; 254,162,0; 128 |
| 6,6,6,0 as Electron 44 OpenH264 wrote it for canvas frames | 2; 254,162,0; 128 | 63; 250,172,0; 139 | 4; 254,162,1; 128 | 2; 254,162,0; 128 | 63; 250,173,0; 139 | 2; 254,162,0; 128 |
| 6,1,6,0 as Chromium 140 VideoToolbox wrote it | 2; 254,162,0; 128 | 63; 250,172,0; 139 | 4; 254,162,1; 128 | 2; 254,162,0; 128 | 63; 250,173,0; 139 | 2; 254,162,0; 128 |
| 1,13,6,0 Electron 44's BT.601 data, both places retagged | 2; 254,162,0; 128 | 3; 254,162,0; 128 | 4; 254,162,1; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 |
| 1,13,1,1 as Chrome 153 wrote it for canvas frames | 2; 255,162,0; 128 | 2; 255,162,0; 128 | 2; 255,162,0; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 |

Only the 1,13,1,1 row stays within 2 levels in every column. The 63s are the saturated patches after AVFoundation's SMPTE-C to sRGB gamut conversion, for example pure green decoding as 63,250,0. With the sRGB transfer tags, AVFoundation's remaining error is its own rounding. ffmpeg gives 254 for pure red in the same full-range file and AVFoundation gives 253. The limited-range file's 2 is pure green's blue channel.

The M3 export as it stands, `out/bear-test/bear-test.mp4` from 17:15 at 2,148,994 bytes, takes the same path as the last row. Chrome Headless Shell 153 tagged it 1,13,1,1 in `colr` and the VUI, and AVFoundation decoded its ground as 255,162,0. The red bear came out at 241,73,33 in ffmpeg and AVFoundation against 243,73,33 in the render, because libyuv's RGB to YUV conversion works in 8-bit fixed point. My own conversion gave 243 and 242.

## Can WebCodecs control the tags?

- `VideoEncoderConfig` has no colour member. The spec's dictionary ends at `contentHint` ([VideoEncoderConfig](https://w3c.github.io/webcodecs/#dictdef-videoencoderconfig)), and Chromium 153's IDL matches ([video_encoder_config.idl](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/third_party/blink/renderer/modules/webcodecs/video_encoder_config.idl)).
- `VideoFrameInit`, used for canvas, `ImageBitmap` and `OffscreenCanvas` sources, has no `colorSpace` member either ([VideoFrameInit](https://w3c.github.io/webcodecs/#dictdef-videoframeinit), [video_frame_init.idl](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/third_party/blink/renderer/modules/webcodecs/video_frame_init.idl)). Passing `colorSpace` there is silently dropped. Every build reported the frame as sRGB and wrote the same tags as without it.
- `VideoFrameBufferInit`, for frames built from pixel buffers, does have `colorSpace` ([video_frame_buffer_init.idl#L27](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/third_party/blink/renderer/modules/webcodecs/video_frame_buffer_init.idl#27)). The spec's Pick Color Space step says "If overrideColorSpace is provided, return a new VideoColorSpace constructed with overrideColorSpace". Without it, RGB formats get the sRGB colour space, which is BT.709 primaries, `iec61966-2-1` transfer, `rgb` matrix and full range, and YUV formats get REC709, which is BT.709 throughout at limited range ([Pick Color Space](https://w3c.github.io/webcodecs/#videoframe-pick-color-space), [sRGB Color Space](https://w3c.github.io/webcodecs/#srgb-color-space)).
- What the encoder writes is up to the implementation. The output algorithm says "Assign the remaining keys of outputConfig as determined by [[codec implementation]]" ([Output EncodedVideoChunks](https://w3c.github.io/webcodecs/#output-encodedvideochunks)).

In Chromium, the frame's colour space decides the VUI. OpenH264's wrapper sets `bVideoSignalTypePresent`, `uiColorPrimaries`, `uiTransferCharacteristics`, `uiColorMatrix` and `bFullRange` from the colour space of the frame it encodes, and re-initialises when that changes ([openh264_video_encoder.cc#L132](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/video/openh264_video_encoder.cc#132)). VideoToolbox's wrapper sets the session's colour properties from the pixel buffer's attachments ([vt_video_encode_accelerator_mac.mm#L657 at 140](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/media/gpu/mac/vt_video_encode_accelerator_mac.mm#657)). An RGB frame is converted to I420 first, and that conversion picks the colour space the encoder sees:

- In 152 the converter says "libyuv's RGB to YUV methods always output BT.601" and tags REC601, whatever the input frame said ([video_frame_converter.cc#L191 at 152](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/media/base/video_frame_converter.cc#191)).
- In 153 `GetDestinationColorSpace` keeps the input's primaries, transfer and range, and picks the BT.709 matrix for BT.709 primaries ([video_frame_converter.cc#L30 at 153](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/base/video_frame_converter.cc#30)).
- A YUV frame passes through unchanged in both: "Converting between YUV formats doesn't change the color space."

What each build wrote to the VUI, as primaries, transfer, matrix and range. `decoderConfig.colorSpace` in the output metadata matched the VUI in every cell, except the two marked.

| Frame source | Chromium 140 VideoToolbox | Electron 44 VideoToolbox | Electron 44 OpenH264 | Chrome 153 OpenH264 | Chrome 153 OpenH264, feature off | Chrome 153 VideoToolbox |
| --- | --- | --- | --- | --- | --- | --- |
| Canvas | 6,1,6,limited | 6,1,6,limited | 6,6,6,limited | 1,13,1,full | 6,6,6,limited | 1,13,1,full |
| Canvas with `colorSpace` in `VideoFrameInit` | same as canvas | same as canvas | same as canvas | same as canvas | same as canvas | not run |
| RGBA buffer, default or explicit sRGB | 6,1,6,limited | 6,1,6,limited | 6,6,6,limited | 1,13,1,full | 6,6,6,limited | not run |
| RGBA buffer, sRGB with `fullRange: false` | 6,1,6,limited | 6,1,6,limited | 6,6,6,limited | 1,13,1,limited | 6,6,6,limited | not run |
| I420 buffer, `colorSpace` 1,13,1,full | 1,13,1,full, reported limited | 1,13,1,full, reported limited | 1,13,1,full | 1,13,1,full | 1,13,1,full | 1,13,1,full |
| I420 buffer, `colorSpace` 1,13,1,limited | 1,13,1,limited | 1,13,1,limited | 1,13,1,limited | 1,13,1,limited | 1,13,1,limited | 1,13,1,limited |
| I420 buffer, no `colorSpace` | 1,1,1,limited | 1,1,1,limited | 1,1,1,limited | 1,1,1,limited | 1,1,1,limited | not run |

Chromium 140's `prefer-software`, which picks VideoToolbox's software encoder, matched the Chromium 140 column. The 6,1,6 from VideoToolbox is REC601 passed through CoreVideo, which has no separate SMPTE 170M curve, so Chromium maps that transfer to `kCVImageBufferTransferFunction_ITU_R_709_2` ([color_space_util.mm#L122](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/ui/gfx/mac/color_space_util.mm#122)).

The "reported limited" cells are a Chromium bug. Before 153, `GetImageBufferColorSpace` built the reported colour space from primaries, transfer, gamma and matrix and never looked at the pixel format's range, so the range defaulted to limited ([color_space_util_mac.mm#L33 at 152](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/media/base/mac/color_space_util_mac.mm#33)). 153 passes `kCVPixelFormatComponentRange` through ([#L58 at 153](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/base/mac/color_space_util_mac.mm#58)), and 153's VideoToolbox reported full. VideoToolbox still wrote `video_full_range_flag = 1` in 140 and 152, and the files decoded correctly by their VUI.

The I420 path also made the output reproducible across browser versions. Electron 44's OpenH264 and Chrome 153's OpenH264 produced byte-identical H.264 streams for `bear-test`, with MD5 `fb1659a9b50bd2ebea3024283ded9882` from `ffmpeg -i f.mp4 -c copy -f h264 - | md5`. Only the MP4 headers differed.

## Can Mediabunny write the colr box?

Yes, from the decoder config it is handed. It writes `colr` into the `avc1` sample entry unless `decoderConfig.colorSpace` is empty ([isobmff-boxes.ts#L772 and #L804](https://github.com/Vanilagy/mediabunny/blob/v1.59.1/src/isobmff/isobmff-boxes.ts#L804)). The box is `nclx` with the full-range bit for MP4 and `nclc` without it for MOV. A member left null becomes 2, unspecified. The values go through the WebCodecs enum names, so only the code points WebCodecs can name can be written ([misc.ts#L417](https://github.com/Vanilagy/mediabunny/blob/v1.59.1/src/misc.ts#L417)), and anything else fails validation ([codec.ts#L1042](https://github.com/Vanilagy/mediabunny/blob/v1.59.1/src/codec.ts#L1042)).

The muxer builds the track from the first packet's metadata and ignores later ones ([isobmff-muxer.ts#L401](https://github.com/Vanilagy/mediabunny/blob/v1.59.1/src/isobmff/isobmff-muxer.ts#L401)). The docs show `colorSpace` inside the metadata passed with the first `add` ([media-sources.md, EncodedVideoPacketSource](https://github.com/Vanilagy/mediabunny/blob/v1.59.1/docs/guide/media-sources.md)). The track option `decoderConfig` can also supply it ahead of time, but it needs the avcC `description`, which only exists after the first chunk. Overriding `meta.decoderConfig.colorSpace` in the encoder's output callback is the practical way. With `null` there, Mediabunny wrote no `colr` at all.

Mediabunny doesn't touch the bitstream, so it can't change the VUI. Overriding `colr` alone fixed AVFoundation for Electron 44's files but not Chrome's on-screen video, as the next section shows.

## Which one wins when colr and the VUI disagree

Same streams, retagged so the two places disagree.

| `colr` | VUI | ffmpeg | AVFoundation | Chromium 153, no GPU | Chromium 153 GPU, canvas | Chromium 153 GPU, on screen | Electron 44 canvas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,13,1,0 | 1,1,1,0 | 1; 254,162,0; 128 | 2; 254,162,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,1,1,0 | 1,13,1,0 | 1; 254,162,0; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| 1,13,1,0 | no signal type | 1; 254,162,0; 128 | 2; 254,162,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| none | 1,13,1,0 | 1; 254,162,0; 128 | 2; 254,162,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| 1,1,1,0 | no signal type | 1; 254,162,0; 128 | 12; 254,172,0; 139 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 11; 254,172,0; 139 | 1; 254,162,0; 128 |
| 1,13,6,0, Mediabunny override only | 6,6,6,0, Electron 44 as written | 2; 254,162,0; 128 | 3; 254,162,0; 128 | 4; 254,162,1; 128 | 2; 254,162,0; 128 | 63; 250,173,0; 139 | 2; 254,162,0; 128 |
| 6,6,6,0 | 1,13,6,0, VUI rewrite only | 2; 254,162,0; 128 | 63; 250,172,0; 139 | 4; 254,162,1; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 | 2; 254,162,0; 128 |
| 1,13,1,1 on full-range data | 1,13,1,0 | 19; 255,170,0; 130 | 19; 255,170,0; 130 | 20; 255,171,0; 130 | 19; 255,170,0; 130 | 19; 255,170,0; 130 | 19; 255,170,0; 130 |
| 1,13,1,0 on full-range data | 1,13,1,1 | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |

- AVFoundation took primaries, transfer and matrix from `colr` when it was there, and from the VUI when it wasn't. CoreMedia put the VUI's values on the format description in that case. It took the range from the VUI even when `colr` disagreed, although the format description's `FullRangeVideo` extension followed `colr`.
- Chromium's on-screen path used only the VUI and ignored `colr`, even with no VUI colour description to fall back from. Its software decoder has the same rule in code: "Prefer the frame color space over what's in the config" ([ffmpeg_video_decoder.cc#L471](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/filters/ffmpeg_video_decoder.cc#471)).
- ffmpeg and every Chromium path took the range from the VUI.

So fixing only `colr`, which is all Mediabunny can do, leaves QuickTime right and Chrome on macOS wrong. Fixing only the VUI does the opposite.

### Rewriting the VUI after muxing

It works. [`mp4tags.py`](#experiments) rewrites `video_signal_type` in every SPS inside `avcC` and rewrites or removes `colr`, and all the retagged files above came from it. To do that it has to remove emulation prevention bytes and walk the SPS through Exp-Golomb fields, including the scaling lists that High profile may carry. It then splices the new bits in, adds the stop bit and padding back, re-inserts emulation prevention, rebuilds `avcC`, fixes every parent box size and shifts `stco` offsets when `moov` precedes `mdat`. ffmpeg's `h264_metadata` filter does the same on packets. `-c copy -bsf:v h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=6`, with `-color_primaries bt709 -color_trc iec61966-2-1 -colorspace smpte170m -movflags +write_colr` for the `colr` box, fixed a Chromium 140 VideoToolbox file for AVFoundation, in-band SPS included.

The obstacle is VideoToolbox. Chromium 140's VideoToolbox files repeated the SPS in every key frame: 5 SPS in 96 frames with 4 key frames. My script only rewrites `avcC` and refuses such files. A JavaScript version would have to rewrite those NAL units too, which changes sample sizes, `stsz` and chunk offsets. That's a lot of bit-level code to own when an I420 `VideoFrame` makes every encoder I tested write the right VUI itself. I recommend against it for M3.

## Why Chromium 153 tags differently from 152

- [crrev.com/c/8161868](https://chromium-review.googlesource.com/c/chromium/src/+/8161868), commit 4c92c1a25f6a, landed 2026-07-29 at main@{#1670702}. It moved `VideoFrameConverter` to libyuv's matrix functions and says "There should be no functional changes in this CL."
- [crrev.com/c/7821801](https://chromium-review.googlesource.com/c/chromium/src/+/7821801), commit 22094ce89ddd, landed 2026-08-17 at main@{#1680740}. Its message is "VideoFrameConverter now supports all combinations of full and limited range combined with BT.601, BT.709, and BT.2020", with "Fixed: 467555325". It added `kAccurateVideoFrameConverterColorSpace`, `FEATURE_ENABLED_BY_DEFAULT`, with the comment "Controls whether VideoFrameConverter accurately maps RGB to YUV color spaces instead of always coercing to Rec.601" and "TODO(crbug.com/467555325): Remove after M153 reaches stable" ([media_switches.cc#L361 at 153](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/base/media_switches.cc#361)). The converter picks libyuv's `kArgbF709Constants` for full-range BT.709 ([video_frame_converter_internals.cc#L44](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/media/base/video_frame_converter_internals.cc#44)).
- [crrev.com/c/8267381](https://chromium-review.googlesource.com/c/chromium/src/+/8267381) reverted it on 2026-08-18 at main@{#1681195} for an Android test failure. [crrev.com/c/8265191](https://chromium-review.googlesource.com/c/chromium/src/+/8265191) relanded it unchanged on 2026-08-20 at main@{#1683478}.
- The 153.0.8010.12 tag says `Cr-Branched-From: 86cee6df69e0-refs/heads/main@{#1681091}`. M153 branched after the landing and before the revert, so it carries the original commit, and the file at that tag contains the feature. 152.0.7977.130 branched at main@{#1669021}, before all of it.

Two runs confirm it. Chrome Headless Shell 153 with `--disable-features=AccurateVideoFrameConverterColorSpace` wrote 6,6,6,limited for canvas frames, the same as Electron 44. With the feature on, it wrote 1,13,1,full.

The same change reaches VideoToolbox through `VideoEncodeAcceleratorAdapter`, and Chrome 153's VideoToolbox also wrote 1,13,1,full for canvas frames. Blink's GPU readback of texture-backed frames changed in the same release: `GetReadbackYuvColorSpace` now keeps the source's primaries and transfer, and its code comment says "The readback frame is always video range" ([video_encoder.cc#L629 at 153](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/third_party/blink/renderer/modules/webcodecs/video_encoder.cc#629)). Our canvases use `willReadFrequently`, which keeps them on the CPU, so I didn't test that path.

For M3 this means the canvas path is right in Chrome 153 by default, wrong in Electron 44 and every older Chrome, and depends on a flag the Chromium team plans to remove. I expect removal to keep the new behaviour, but I haven't verified that.

## Upload pipelines and Windows

YouTube recommends BT.709 with transfer 1 for SDR uploads. Its help page says "Note that sRGB TRC will convert to BT.709 TRC" and "YouTube converts full color range to limited color range" ([YouTube upload encoding settings](https://support.google.com/youtube/answer/1722171)). If that conversion applies the curves exactly, sRGB decode then the BT.709 camera curve, our grey 128 becomes 115 in the uploaded stream and `#ffa200` becomes 255,152,0. Chrome would show those values, since it draws BT.709 as sRGB. Safari would show about 126 and 255,162,0, since Apple's 1.961 curve nearly undoes the change. I computed this and didn't upload anything. It's a reason to measure YouTube before promising exact colour there, and possibly a reason for a later "for upload" option that tags 1,1,1. Such a file decodes exactly in Chrome, and AVFoundation lifts grey to 139.

I couldn't test Windows. Microsoft's H.264 decoder page doesn't describe how the decoder uses the VUI colour fields, so whether Media Foundation, the Photos and Media Player apps, and Edge honour transfer 13 and the full-range flag is unknown.

## Experiments

### Setup

Everything ran from `/tmp/fs-colour`, reusing ticket 14's CDP client (`/tmp/fs-cdp/cdp.mjs`), its `mediabunny@1.59.1` and `esbuild@0.28.2` install and its Electron 44.4.5 install. A static server on `127.0.0.1:8124` served the pages and accepted `POST /save`.

| Label | Launch |
| --- | --- |
| Chromium 140 | `hs140/chrome-mac/headless_shell --remote-debugging-port=9511 --user-data-dir=... --enable-gpu --disable-accelerated-2d-canvas --disable-skia-runtime-opts --force-color-profile=srgb`. Playwright's cached copy was deleted mid-session, so I unzipped Playwright's own download, `playwright-download-chromium-headless-shell-mac15-arm64-1187.zip`, which reports 140.0.7339.16 |
| Chrome 153 | Playwright 1.63.0's `chrome-headless-shell` with the same flags minus `--enable-gpu`. A second instance added `--disable-features=AccurateVideoFrameConverterColorSpace`. A third added `--enable-gpu` for VideoToolbox and the GPU decode paths |
| Electron 44 | A hidden `BrowserWindow` with `force-color-profile=srgb`. The decode runs added `disable-gpu` or `disable-accelerated-video-decode` where noted |

The test frame was 1920x1080 at 12 fps, drawn in a canvas with `{ willReadFrequently: true, colorSpace: 'srgb', alpha: false }`. It had a 3x3 grid of flat patches: `#ffa200`, `#ffffff`, `#e8543a`, `#808080`, `#ff0000`, `#00ff00`, `#0000ff`, `#000000` and the paper tone `#f4efe6`, plus a small moving square in a corner. Files were 24 or 72 frames, `avc1.640028`, 8 Mbps, a key frame every 2 s, muxed by Mediabunny with `frameRate: 12`. Every decoder read the frame at 1.0 s and averaged the central 32x32 pixels of each patch.

The frame sources in the encode suite, `colour-src.js`:

```js
new VideoFrame(canvas, { timestamp, duration });                               // canvas
new VideoFrame(canvas, { timestamp, duration, colorSpace });                   // canvas with colorSpace
new VideoFrame(ctx.getImageData(0, 0, W, H).data, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp, duration, colorSpace });
new VideoFrame(i420, { format: 'I420', codedWidth: W, codedHeight: H, timestamp, duration, colorSpace, transfer: [i420.buffer] });
```

The I420 data came from my own float conversion, BT.709 matrix, full or limited range, with 2x2 chroma averaging.

### Commands

```sh
node run-suite.mjs 9512 hs153 prefer-software          # Chrome 153 OpenH264, all frame sources
node run-suite.mjs 9513 hs153off prefer-software       # same with the feature disabled
node run-suite.mjs 9511 hs140vt no-preference          # Chromium 140 VideoToolbox
electron electron/suite.cjs --prefix=e44sw --accel=prefer-software   # ELECTRON_RUN_AS_NODE unset
electron electron/suite.cjs --prefix=e44vt --accel=prefer-hardware

# colr and VUI of a file
ffmpeg -v trace -i f.mp4 -c copy -bsf:v trace_headers -frames:v 1 -f null - 2>&1 \
  | grep -E "nclx: pri|video_signal_type_present_flag|video_full_range_flag|colour_primaries|transfer_characteristics|matrix_coefficients"

# retag without re-encoding
python3 mp4tags.py in.mp4 out.mp4 --colr 1,13,1,0 --vui 1,1,1,0     # or --colr none / --vui none

# ffmpeg decode of the frame at 1.0 s
ffmpeg -v error -i f.mp4 -vf 'select=gte(t\,0.999)' -frames:v 1 \
  -sws_flags accurate_rnd+full_chroma_int+bitexact -pix_fmt rgb24 -f rawvideo -

# AVFoundation decode, Swift, avf/avcolour.swift
swiftc -O avf/avcolour.swift -o avf/avcolour && avf/avcolour f.mp4
```

`avcolour` uses the same method as ticket 14. `AVAssetImageGenerator` extracts the frame with zero tolerance, and the `CGImage` is drawn into an 8-bit `CGContext` whose colour space is `CGColorSpace.sRGB`, so ColorSync converts from whatever the tags imply into sRGB. It also reads the frame with `AVAssetReaderTrackOutput` at `kCVPixelFormatType_32BGRA`, once without colour properties and once with `AVVideoColorPropertiesKey` set to BT.709 primaries, `AVVideoTransferFunction_IEC_sRGB` and the BT.709 matrix. It prints the format description's colour extensions and the pixel buffer's attachments. Without colour properties the reader applies only the matrix and range. It matched ffmpeg to within 1 level, except on the untagged file, where ffmpeg assumed the BT.601 matrix and AVFoundation BT.709. With colour properties it converted the transfer like the image generator but skipped the SMPTE 170M gamut conversion, giving 12 where the generator gave 63.

For Chromium, `decode.js` fetches the file as a blob, plays it in a muted `<video>`, seeks to 1.0 s and waits for `requestVideoFrameCallback`. It then calls `drawImage` into a 2D canvas with `{ willReadFrequently: true, colorSpace: 'srgb' }` and reads `getImageData`. The on-screen number comes from the same video shown at 1:1 and captured with CDP `Page.captureScreenshot`. A canvas without `willReadFrequently` gave the same values as the CPU canvas to within 1 level in every build.

### Recommended path in every build

The I420 path with `colorSpace` 1,13,1,full and the Mediabunny override, 72 frames. VUI and `colr` were 1,13,1,full in every file.

| Encoder | ffmpeg | AVFoundation | Chromium 153, no GPU | Chromium 153 GPU, canvas | Chromium 153 GPU, on screen | Electron 44 canvas |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 140 VideoToolbox | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Chromium 140 VideoToolbox software | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Electron 44 VideoToolbox | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Electron 44 OpenH264 | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Chrome 153 OpenH264 | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Chrome 153 OpenH264, feature off | 1; 255,162,0; 128 | 2; 255,162,0; 128 | 1; 255,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |
| Same path at limited range, any of the three encoders | 1; 254,162,0; 128 | 2; 254,162,0; 128 | 12; 254,163,8; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 | 1; 254,162,0; 128 |

### bear-test

96 frames rendered by the repo's engine and rigs, bundled with esbuild from `src/engine/index.ts` and `src/rigs/index.ts`. I sampled four 32x32 areas at frame 12. In the render, the ground at x 1732, y 92 was 255,162,0, the white bear at 360,900 was 255,255,255, the red bear at 1400,900 was 243,73,33 and the muzzle at 530,580 was 174,179,194. Cells give the ground decode and the worst error over the four areas.

| File | ffmpeg | AVFoundation | Chromium 153, no GPU | Chromium 153 GPU, canvas | Chromium 153 GPU, on screen | Electron 44 canvas |
| --- | --- | --- | --- | --- | --- | --- |
| Recommended path, Chrome 153 OpenH264, `bear-colour-fixed` | 255,162,0; 1 | 255,162,0; 1 | 255,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 |
| Recommended path, Electron 44 OpenH264 | 255,162,0; 1 | 255,162,0; 1 | 255,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 |
| Recommended path, Electron 44 VideoToolbox | 255,162,0; 1 | 255,162,0; 1 | 255,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 |
| Recommended path, Chromium 140 VideoToolbox | 255,162,0; 1 | 255,162,0; 1 | 255,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 |
| M3's `out/bear-test/bear-test.mp4`, canvas frames, Chrome 153 | 255,162,0; 2 | 255,162,0; 2 | 255,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 | 254,162,0; 1 |
| Ticket 14, Electron 44 OpenH264 canvas | 254,162,0; 1 | 250,172,0; 18 | 254,162,1; 1 | 254,162,0; 1 | 250,173,0; 17 | 254,162,0; 1 |
| Ticket 14, Chromium 140 VideoToolbox canvas | 254,162,0; 1 | 250,172,0; 18 | 254,162,1; 1 | 254,162,0; 1 | 250,173,0; 17 | 254,162,0; 1 |

`bear-colour-fixed.mp4` is in `out/encoding-preview/`. It has 96 frames, lasts 8.000000 s at 12/1, is High 4.0, and plays cleanly in ffmpeg. In AVFoundation, ticket 14's Electron file also turned the red bear into 238,91,34.

### Cost

On `bear-test` in Chrome Headless Shell 153, the canvas path took 55.2 ms a frame and the I420 path 68.6 ms. Per frame, the engine's draw calls took 9 ms and `getImageData` took 45 ms, which is mostly the deferred raster that the canvas path pays when it snapshots the frame. The JavaScript conversion took 12 ms. A lookup-table version wasn't faster. On a 1080p `OffscreenCanvas`, `getImageData` took 94 ms against 45 ms on a DOM canvas, so the export should read from the page's own canvas.

## Recommendation for M3

1. Export with these tags in both the VUI and `colr`: primaries 1, transfer 13, matrix 1, full range. In WebCodecs terms, `{ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true }`.
2. Don't hand canvas frames to the encoder. Read the canvas, convert to I420 with the BT.709 matrix at full range, and pass the colour space on the `VideoFrame`. That is the only route that wrote the right VUI in Electron 44, Chromium 140 and Chrome 153 alike. It also made OpenH264's output byte-identical across Chromium 152 and 153.
3. Write the same colour space into Mediabunny's metadata on the first packet, rather than trusting `decoderConfig.colorSpace`. Keep a check that the reported primaries, transfer and matrix match, so an encoder that ignores the frame's colour space fails loudly instead of producing a file whose `colr` and VUI disagree.
4. Don't rewrite the VUI after muxing, and don't retag `colr` alone.

This is the code that made `bear-colour-fixed.mp4`, from `/tmp/fs-colour/recommended-export.js` with its header comment shortened:

```js
import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';

// H.273: colour_primaries 1, transfer_characteristics 13, matrix_coefficients 1, video_full_range_flag 1.
export const EXPORT_COLOR_SPACE = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true };

// sRGB-encoded RGBA -> I420 with the BT.709 matrix at full range. 2x2 chroma average. Even sizes only.
export function rgbaToI420Bt709Full(rgba, W, H, out = new Uint8Array((W * H * 3) / 2)) {
  const KR = 0.2126, KB = 0.0722, KG = 1 - KR - KB;
  const CU = 1 / (2 * (1 - KB)), CV = 1 / (2 * (1 - KR));
  const cW = W >> 1, uBase = W * H, vBase = uBase + cW * (H >> 1);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      let su = 0, sv = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (y + dy) * W + x + dx, p = i * 4;
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
          const l = KR * r + KG * g + KB * b;
          out[i] = clamp(l);
          su += (b - l) * CU;
          sv += (r - l) * CV;
        }
      }
      const c = (y >> 1) * cW + (x >> 1);
      out[uBase + c] = clamp(128 + su / 4);
      out[vBase + c] = clamp(128 + sv / 4);
    }
  }
  return out;
}

// canvas is the page's own <canvas>. drawFrame(ctx, f) draws frame f.
export async function exportMp4({ canvas, W, H, fps, frameCount, drawFrame, codec = 'avc1.640028', bitrate = 8_000_000, hardwareAcceleration = 'no-preference' }) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  let pending = Promise.resolve();
  let encodeError = null;
  let reportedColorSpace;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) {
        const cs = meta.decoderConfig.colorSpace;
        reportedColorSpace ??= cs;
        // An encoder that ignored the frame's colour space would leave other values in the VUI.
        if (cs?.primaries !== 'bt709' || cs?.transfer !== 'iec61966-2-1' || cs?.matrix !== 'bt709') {
          encodeError ??= new Error(`Encoder wrote colour space ${JSON.stringify(cs)}, expected BT.709 / sRGB / BT.709`);
        }
        // The colr box must match the SPS VUI. VideoToolbox in Chromium 140 and 152 writes
        // video_full_range_flag 1 but reports fullRange false here, so don't trust the report.
        meta = { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: EXPORT_COLOR_SPACE } };
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      pending = pending.then(() => source.add(packet, meta));
    },
    error: (e) => { encodeError = e; },
  });
  const config = { codec, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration, avc: { format: 'avc' }, latencyMode: 'quality' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error(`H.264 config not supported: ${JSON.stringify(config)}`);
  encoder.configure(config);

  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb', alpha: false });
  for (let f = 0; f < frameCount; f++) {
    drawFrame(ctx, f);
    const rgba = ctx.getImageData(0, 0, W, H, { colorSpace: 'srgb' }).data;
    const i420 = rgbaToI420Bt709Full(rgba, W, H);
    const frame = new VideoFrame(i420, {
      format: 'I420', codedWidth: W, codedHeight: H,
      timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps),
      colorSpace: EXPORT_COLOR_SPACE, transfer: [i420.buffer],
    });
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    if (encodeError) throw encodeError;
  }
  await encoder.flush();
  encoder.close();
  await pending;
  await output.finalize();
  if (encodeError) throw encodeError;
  return { bytes: output.target.buffer, reportedColorSpace };
}
```

M3 already uses `fastStart: 'reserve'`. The colour code doesn't depend on that choice. If the extra 12 ms a frame matters, the conversion can move to a worker that takes the transferred `ImageData` buffer while the page draws the next frame. I didn't build that.

The export test should check both tags and pixels:

- `ffprobe -v error -select_streams v:0 -show_entries stream=color_range,color_space,color_primaries,color_transfer` must print `pc`, `bt709`, `bt709`, `iec61966-2-1`. ffprobe reports what the decoder read, which is the VUI when the SPS has one.
- The `colr` box must be `nclx` 1, 13, 1 with the full-range bit set. `ffmpeg -v trace` prints `nclx: pri 1 trc 13 matrix 1 full 1`, or the test can parse the box.
- Decode frame 12 with ffmpeg as above and require the ground at x 1732, y 92, averaged over 32x32, to be within 1 of 255,162,0. If the test decodes in Chrome Headless Shell instead, keep the file full range, or libyuv's limited-range clamp will fail it on blue.
- On macOS dev machines, the Swift tool in `/tmp/fs-colour/avf` can run the same check through AVFoundation.

## Not verified

- Windows. I didn't test Media Foundation, the Photos or Media Player apps, or Edge with 1,13,1,full files. Microsoft's decoder documentation doesn't say how the VUI colour fields are used.
- Firefox, Safari itself and iOS. AVFoundation stands in for Safari and QuickTime. I measured AVFoundation's output with an image generator drawn into sRGB, not QuickTime Player's pixels on a P3 display.
- Whether WebKit's and Firefox's `VideoEncoder` copy an I420 frame's `colorSpace` into the VUI. The check in the recommended code is there for that case.
- YouTube and other upload pipelines. The 115 grey is my arithmetic from YouTube's help text, not an upload.
- Media Foundation's hardware encoder, VA-API and OpenH264 on Linux and Windows. The libyuv clamp comes from source that is the same on every platform, but I only measured it on macOS.
- How Chrome's on-screen macOS path picks Apple's BT.709 curve. The `BT709_APPLE` mapping is my reading of the source. Software decode with GPU compositing wasn't isolated in 153. Electron 44 with `--disable-accelerated-video-decode` drew exact values into a canvas, but I didn't screenshot it.
- Chromium 140 has no H.264 decoder, so it appears only as an encoder.
- Whether `AccurateVideoFrameConverterColorSpace` keeps its behaviour when the flag is removed, and which Electron release first ships Chromium 153 or later.
- The code point meanings come from the WebCodecs enum definitions, which cite H.273 table values, and from Apple's and Chromium's headers. ITU's download of H.273 failed with a server error, so I didn't read the recommendation itself. ISO/IEC 14496-12's `colr` definition is paywalled, and I relied on Mediabunny's writer, ffmpeg's parser and Apple's `colr` atom page.
- Only flat patches and four areas of `bear-test` were measured. Antialiased edges, gradients and colours other than these weren't checked.
- Other codecs. VP9, AV1 and HEVC weren't tested.

## Sources

- W3C WebCodecs editor's draft: `VideoEncoderConfig`, `VideoFrameInit`, `VideoFrameBufferInit`, Pick Color Space, the sRGB and REC709 colour spaces, the `VideoColorPrimaries`, `VideoTransferCharacteristics` and `VideoMatrixCoefficients` enums with their H.273 values, and Output EncodedVideoChunks: https://w3c.github.io/webcodecs/
- ITU-T H.273, cited through the above: https://www.itu.int/rec/T-REC-H.273
- Chromium at tag 153.0.8010.12: `media/base/video_frame_converter.cc`, `media/base/video_frame_converter_internals.cc`, `media/base/media_switches.cc`, `media/video/openh264_video_encoder.cc`, `media/base/mac/color_space_util_mac.mm`, `ui/gfx/mac/color_space_util.mm`, `ui/gfx/color_space.cc`, `media/filters/ffmpeg_video_decoder.cc`, `media/base/video_util.cc`, `media/renderers/paint_canvas_video_renderer.cc`, `third_party/blink/renderer/modules/webcodecs/{video_encoder.cc,video_encoder_config.idl,video_frame_init.idl,video_frame_buffer_init.idl}`, `DEPS`: https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12
- Chromium at 152.0.7977.130, `media/base/video_frame_converter.cc` and `media/base/mac/color_space_util_mac.mm`, and at 140.0.7339.16, `media/gpu/mac/vt_video_encode_accelerator_mac.mm`, linked inline.
- Chromium changes 8161868, 7821801, 8267381, 8265191, 8271488 and its M153 cherry-pick 8281187, and bug 467555325: https://chromium-review.googlesource.com/q/bug:467555325, https://issues.chromium.org/issues/467555325
- libyuv at 26e56be0f984, Chromium 153's pinned revision, `source/row_common.cc` and `BUILD.gn`: https://chromium.googlesource.com/libyuv/libyuv/+/26e56be0f984af3dae4d0c0ab7a0bac8ac20e1b0
- FFmpeg n7.1.1 `libavcodec/h264_slice.c` and `libavformat/mov.c`: https://github.com/FFmpeg/FFmpeg/tree/n7.1.1. The `h264_metadata` options come from `ffmpeg -h bsf=h264_metadata`.
- Mediabunny 1.59.1 `src/isobmff/isobmff-boxes.ts`, `src/isobmff/isobmff-muxer.ts`, `src/misc.ts`, `src/codec.ts` and `docs/guide/media-sources.md`: https://github.com/Vanilagy/mediabunny/tree/v1.59.1
- Apple TN2227, Video Color Management in AV Foundation and QTKit: https://developer.apple.com/library/archive/technotes/tn2227/_index.html
- Apple QuickTime File Format, color parameter atom: https://developer.apple.com/documentation/quicktime-file-format/color_parameter_atom
- Apple CoreVideo `kCVImageBufferTransferFunction_sRGB` and AVFoundation `AVVideoTransferFunction_IEC_sRGB`, with the macOS 27 SDK headers `CVImageBuffer.h` and `AVVideoSettings.h`: https://developer.apple.com/documentation/corevideo/kcvimagebuffertransferfunction_srgb, https://developer.apple.com/documentation/avfoundation/avvideotransferfunction_iec_srgb
- YouTube recommended upload encoding settings, colour space section: https://support.google.com/youtube/answer/1722171
- Microsoft H.264 video decoder: https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder
- Scripts and outputs: `/tmp/fs-colour`. `colour-src.js` is the encode suite, `www/decode.js` and `run-decode.mjs` the Chromium decode, `avf/avcolour.swift` the AVFoundation decode, `ffcolour.py` the ffmpeg decode, `tags.sh` the tag dump, `mp4tags.py` the retagger, `recommended-export.js` and `bear-src.js` the recommended export, and `tables.py` builds the tables above from the `*-results.jsonl` files.
