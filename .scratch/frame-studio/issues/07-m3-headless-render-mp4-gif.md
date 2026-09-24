# M3: Headless render, MP4, and GIF

Type: task
Status: resolved
Blocked by: 03, 06, 14

## Work

Build milestone M3 as written in `docs/ROADMAP.md`, using the capture method from ticket 03 and the encoder path from ticket 14. The roadmap's commands name `fly-test`. Use `bear-test` instead, since the bear replaced the fly in M2.

The export path must work in the dev CLI, the Electron app and the web app (`docs/adr/0001-web-and-electron-targets.md`). Keep the part that drives the page, whether Playwright, a hidden Electron window or the viewer tab itself, behind `window.studio.renderFrame(n)`, so any of them can run an export.

Ticket 14 settled the encoder. The render page encodes with WebCodecs `VideoEncoder` and muxes with Mediabunny, and writes GIFs with gifenc plus our own palette code. Follow the numbered "Recommendation for M3" in `research/export-encoding.md`. Three things change plans made before it:

- Use Playwright 1.57 or later, which ships Chrome for Testing with OpenH264. Ticket 03 pinned 1.55.0, whose open-source headless shell has no H.264 encoder without a GPU. Re-run ticket 03's pixel checks on the new build before recording any reference image.
- Mediabunny and gifenc are the viewer's first runtime dependencies. `tests/runtime-budget.test.ts` fails on any `dependencies` field in `package.json`. Narrow that check to what it protects: `src/engine`, `src/rigs` and `src/audio` still import nothing third-party, and that import scan already exists.
- ffmpeg is no longer part of export. It stays a dev-only tool for checking files, and `CLAUDE.md` now says so.

M3 closes only after ticket 15 settles the MP4 colour tags.

## Answer

M3 is done and its three acceptance criteria pass. `docs/PROGRESS.md` records how each was checked.

- `npm run render -- --scene bear-test --frame 47` writes a PNG. `npm run export -- --scene bear-test --target mp4` and `--target gif` write 96 frames lasting exactly 8 s at 12 fps. `npm run contact-sheet` writes a grid of every Nth frame.
- Exports encode in the page (`src/export/`), using WebCodecs H.264 with Mediabunny, and gifenc with our own palette code. The MP4s carry ticket 15's colour tags, and QuickTime, Chromium and ffmpeg decode them to the scene's colours.
- `npm run test:browser` covers the determinism test on every scene, ticket 03's checks on Chrome Headless Shell 153, and the exports' frame counts, durations and colours.
- A `/code-review` at high effort found ten issues, and all ten are fixed.
