# How should exports encode MP4 and GIF in the web app, in Electron and from the CLI?

Type: research
Status: open
Blocked by: none

## Question

`CLAUDE.md` plans MP4 and GIF export through ffmpeg, driven by Playwright. The studio now has to ship as a web app and as an Electron app (`docs/adr/0001-web-and-electron-targets.md`). A browser tab has no ffmpeg. A shipped Electron app would have to bundle it, and an ffmpeg build with libx264 is GPL. Which encoder path serves all three places an export runs: the dev CLI (`npm run export`), the Electron app and a browser tab?

Candidates:

- An ffmpeg binary, for the CLI and bundled with Electron.
- ffmpeg compiled to WebAssembly, for the browser.
- WebCodecs `VideoEncoder` and `AudioEncoder` with a JavaScript MP4 muxer, such as mp4-muxer or its successor Mediabunny.
- A JavaScript or WebAssembly GIF encoder, since WebCodecs does not write GIF.

Settle these:

1. Where does WebCodecs H.264 encoding work? Cover Chrome, Edge, Safari and Firefox on macOS, Windows and Linux, and Electron on each OS. Which encoder backs it on each OS: VideoToolbox, Media Foundation, OpenH264 or software? Does `isConfigSupported` answer truthfully? Which profiles, levels and sizes work, and is 1920x1080 at 12, 24 and 30 fps always one of them?
2. What about audio? Can AAC or Opus go into MP4 through `AudioEncoder`, on which platforms, and do mainstream players accept Opus in MP4? M7 renders audio with `OfflineAudioContext`, and ticket 04 settled on 48 kHz.
3. Timing. Can we set exact per-frame timestamps and a constant frame rate, so the file has exactly `frameCount` frames and the scene's duration? M3's acceptance checks both.
4. Licensing and size for each path. That covers GPL or LGPL ffmpeg builds in a distributed app, H.264 patent licensing when we encode versus when the OS encoder does, and the download size of ffmpeg.wasm against a muxer library.
5. GIF. Compare palette quality and speed across a JS or wasm encoder and ffmpeg's `palettegen` and `paletteuse` on the `bear-test` frames. The gouache texture is a hard case for a 256-colour palette.
6. Can one path serve all three places? For example, WebCodecs everywhere, with the CLI driving a Chromium page. If not, which split costs least to keep in step?

Priority: local files come first (ADR 0001). The CLI and Electron paths must work first. The web app will get a backend later, so encoding on that backend is a valid answer for the web, as long as the local choice does not rule it out. Note that GPL terms apply when a binary is distributed, as in an Electron bundle, and not when ffmpeg runs on our own server.

Out of scope: the determinism of the frames themselves. Ticket 03 covers capture. Encoded bytes need not be identical run to run, but the frame count and timing must be exact.

## Answer
