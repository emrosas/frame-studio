# Which colour tags make an exported MP4 decode to the scene's exact colours everywhere?

Type: research
Status: resolved
Blocked by: 14

## Question

Ticket 14 found that WebCodecs H.264 output carries different `colr` tags depending on the Chromium build, and AVFoundation, which QuickTime uses, colour-manages by those tags. The `#ffa200` ground of `bear-test` decoded as 255,162,0 only in the file from Chrome Headless Shell 153, which was tagged BT.709 primaries, sRGB transfer and full range. Files from Chromium 140 with VideoToolbox, Electron 44 with OpenH264 and untagged x264 all shifted it to about 250,172,0. ffmpeg decoded every file within one level. The table is in `research/export-encoding.md`, under "Colour metadata".

Which tags should every export carry so that ffmpeg, Chromium, AVFoundation, Windows' players and the usual upload pipelines decode the scene's sRGB colours within one level? Can `VideoEncoder` be told which tags to write, through `VideoEncoderConfig` or the frame's `VideoColorSpace`? If not, can Mediabunny, or a small patch after muxing, rewrite `colr` and the matching H.264 VUI fields without re-encoding? Why did Chromium 153 change the tags from 152, and which change did it?

M3's MP4 export is not done until this has an answer and a test that checks a known colour after decoding.

## Answer

Tag every MP4 with BT.709 primaries, the sRGB transfer curve and the BT.709 matrix at full range. Those are H.273 code points 1, 13 and 1 with the full-range flag, and they go in both the SPS VUI and the `colr` box. AVFoundation reads primaries and transfer from `colr`. Chrome's on-screen video on macOS reads them from the VUI. Every decoder takes the range from the VUI. With these tags, nine test colours decoded within 1 level in ffmpeg and every Chromium path, and within 2 in AVFoundation. Transfer 1, 2 or no tags lifts mid-grey from 128 to 139 on macOS. Limited range trips a libyuv clamp in Chromium's CPU decode path.

`VideoEncoderConfig` has no colour member, and a canvas `VideoFrame` ignores one. So M3 converts each frame to I420 with the BT.709 matrix at full range, passes the colour space on the `VideoFrame`, and writes the same colour space into Mediabunny's metadata. If the encoder reports other primaries, transfer or matrix, it fails loudly. This worked for OpenH264 and VideoToolbox in Chromium 140, 152 and 153. Chromium 153 changed its canvas tags in commit 22094ce89ddd, behind the feature `AccurateVideoFrameConverterColorSpace`.

M3 now does this. Its `bear-test` export reads `pc, bt709, iec61966-2-1, bt709` in ffprobe and `nclx: pri 1 trc 13 matrix 1 full 1` in ffmpeg's trace. The ground decodes as 255,162,0 in both ffmpeg and AVFoundation. Windows, Firefox, real Safari and YouTube were not tested.

Findings: [research/mp4-colour-tags.md](../research/mp4-colour-tags.md)
