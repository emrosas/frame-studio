# Which colour tags make an exported MP4 decode to the scene's exact colours everywhere?

Type: research
Status: open
Blocked by: 14

## Question

Ticket 14 found that WebCodecs H.264 output carries different `colr` tags depending on the Chromium build, and AVFoundation, which QuickTime uses, colour-manages by those tags. The `#ffa200` ground of `bear-test` decoded as 255,162,0 only in the file from Chrome Headless Shell 153, which was tagged BT.709 primaries, sRGB transfer and full range. Files from Chromium 140 with VideoToolbox, Electron 44 with OpenH264 and untagged x264 all shifted it to about 250,172,0. ffmpeg decoded every file within one level. The table is in `research/export-encoding.md`, under "Colour metadata".

Which tags should every export carry so that ffmpeg, Chromium, AVFoundation, Windows' players and the usual upload pipelines decode the scene's sRGB colours within one level? Can `VideoEncoder` be told which tags to write, through `VideoEncoderConfig` or the frame's `VideoColorSpace`? If not, can Mediabunny, or a small patch after muxing, rewrite `colr` and the matching H.264 VUI fields without re-encoding? Why did Chromium 153 change the tags from 152, and which change did it?

M3's MP4 export is not done until this has an answer and a test that checks a known colour after decoding.

## Answer
