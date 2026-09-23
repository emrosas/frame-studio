# M3: Headless render, MP4, and GIF

Type: task
Status: open
Blocked by: 03, 06, 14

## Work

Build milestone M3 as written in `docs/ROADMAP.md`, using the capture method from ticket 03 and the encoder path from ticket 14. The roadmap's commands name `fly-test`. Use `bear-test` instead, since the bear replaced the fly in M2.

The export path must work in the dev CLI, the Electron app and the web app (`docs/adr/0001-web-and-electron-targets.md`). Keep the part that drives the page, whether Playwright, a hidden Electron window or the viewer tab itself, behind `window.studio.renderFrame(n)`, so any of them can run an export.
