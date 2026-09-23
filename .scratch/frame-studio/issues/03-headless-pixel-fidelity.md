# Can a headless render match the browser's canvas pixel for pixel?

Type: research
Status: resolved
Blocked by: none

## Question

M3's determinism test compares pixels between seeking and sequential playback. M4 requires the embed's frames to match the headless PNG renders pixel for pixel.

What can make the same canvas drawing code produce different pixels in headed Chrome, Playwright's headless shell, and Playwright's full Chromium? Cover GPU versus software rasterization, colour spaces and display profiles, devicePixelRatio, and PNG encoding. Which capture method returns the canvas's exact pixels: `getImageData`, `toDataURL`, `toBlob`, or a page screenshot? Which Chromium flags pin the rasterizer so results repeat across runs and machines?

## Answer

Yes, when the canvas uses Skia's CPU rasterizer in one pinned Chromium build on one OS and CPU architecture. In that setup the headless shell, full Chromium in new headless mode, and a headed window produced byte-identical frames. GPU raster changed about half the pixels, and Chromium can switch a canvas between GPU and CPU mid-session. For M3, launch the headless shell with `--disable-accelerated-2d-canvas --disable-skia-runtime-opts`, pin Playwright exactly, create every context with `{ willReadFrequently: true, colorSpace: "srgb" }`, and write frames with `canvas.toBlob("image/png")` rather than page screenshots, since it decodes to exactly the `getImageData` bytes. For M4, run the embed in the same Playwright launch and machine as the reference render, seek synchronously, read with `getImageData`, and compare decoded RGBA with zero tolerance.

Findings: [research/headless-pixel-fidelity.md](../research/headless-pixel-fidelity.md)
