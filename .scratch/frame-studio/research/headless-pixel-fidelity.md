# Can a headless render match the browser's canvas pixel for pixel?

Research for [issue 03](../issues/03-headless-pixel-fidelity.md). Checked 2026-09-22 against Playwright 1.55.0, which pins Chromium 140.0.7339.16 as revision 1187. That is the headless shell already cached on the dev machine, an Apple M1 Pro on macOS 27.

## Question

M3's determinism test compares pixels between seeking and sequential playback. M4 requires the embed's frames to match the headless PNG renders pixel for pixel. What makes the same Canvas 2D code produce different pixels in headed Chrome, Playwright's headless shell, and Playwright's full Chromium? Which capture method returns the canvas's exact pixels? Which Chromium flags pin the rasterizer?

## Short answer

Yes, but only when the canvas is rasterized by Skia's CPU backend in one pinned Chromium build on one OS and CPU architecture. The rasterizer decides the pixels. The browser mode barely matters. With 2D canvas acceleration off, the headless shell, full Chromium in new headless mode, and a headed full Chromium window produced byte-identical frames in my tests. With acceleration on, the same frame differed in 985,454 of 2,073,600 pixels.

Chromium can also switch a canvas between GPU and CPU mid-session, so a frame's pixels can depend on what ran before it. That breaks seek versus sequential comparisons. Launch with `--disable-accelerated-2d-canvas` and `--disable-skia-runtime-opts`, and create every 2D context with `{ willReadFrequently: true, colorSpace: "srgb" }`.

Capture with `getImageData`, `toBlob`, or `toDataURL`. All three returned identical pixels in every configuration. A page screenshot is compositor output. It matches only at device scale factor 1 with no CSS scaling and a forced sRGB display profile.

For M4, run the embed in the same Playwright browser, with the same flags, on the same machine and in the same test run as the reference render. Compare decoded RGBA, never PNG bytes.

## What changes the pixels

### GPU versus CPU rasterization

The HTML spec leaves this choice to the browser. `willReadFrequently` "tell[s] the user agent that the webpage is likely to perform many readback operations and that it is advantageous to use a software canvas", and the spec says the browser "may" act on it ([HTML, the canvas settings, 4.12.5.1.2](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently)). The spec also says antialiasing "can similarly be implemented using oversampling", so antialiasing itself is left to the implementation ([HTML 4.12.5.1, coordinate space note](https://html.spec.whatwg.org/multipage/canvas.html#2dcontext)).

Chromium accelerates a 2D canvas unless one of several conditions says no. The `--disable-accelerated-2d-canvas` flag turns it off ([html_canvas_element.cc#1571](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc#1571)). A context created with `willReadFrequently: true` prefers CPU ([html_canvas_element.cc#1659](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc#1659)). The old rule that canvases under 128 by 129 pixels stay on CPU no longer applies, because `AcceleratedSmallCanvases` ships as stable ([runtime_enabled_features.json5#223](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/platform/runtime_enabled_features.json5#223)).

Which browser gets which rasterizer:

- Playwright's headless shell is Chromium's old headless mode ([Playwright, browsers](https://playwright.dev/docs/browsers#chromium-headless-shell)). It forces `--use-gl=angle --use-angle=swiftshader-webgl` unless you pass `--enable-gpu`, `--use-gl`, or `--use-angle` ([headless_content_main_delegate.cc#266](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/lib/headless_content_main_delegate.cc#266)). The switch header says "Headless uses swiftshader by default for consistency across headless environments" ([headless/public/switches.h#63](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/public/switches.h#63)). SwiftShader here serves WebGL only. CDP `SystemInfo.getInfo` reported `2d_canvas: unavailable_software`, so the canvas raster runs on the CPU.
- Full Chromium, headed or in new headless mode, is "the real Chrome browser" ([Playwright, browsers](https://playwright.dev/docs/browsers#chromium-new-headless-mode), [Chrome headless docs](https://developer.chrome.com/docs/chromium/headless)). On this Mac it reported `2d_canvas: enabled` with Skia Graphite on ANGLE Metal, so the canvas raster runs on the GPU.
- A user's everyday Chrome is full Chrome with GPU raster and whatever version they have installed.

Measured on one 1920 by 1080 test frame, CPU raster versus Graphite on Metal differed in 985,454 pixels. Of those, 849,408 were off by one level and 74,055 by more than nine, with a maximum of 136 at shape edges. That pattern fits gradient rounding across large areas plus different antialiasing coverage at edges.

`--use-angle=swiftshader` does not pin the CPU path. It turns on accelerated canvas with Graphite running on SwiftShader, which gave a third distinct result.

### The raster mode can change mid-session

Two Chromium behaviours move a canvas between GPU and CPU while the page runs, so the same frame drawn twice can come out different.

- Readback fallback. When `willReadFrequently` is unset, an accelerated canvas drops to CPU after `kFallbackToCPUAfterReadbacks = 2` calls to `getImageData` ([base_rendering_context_2d.cc#466](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc#466), [base_rendering_context_2d.h#79](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.h#79)). In GPU-enabled browsers, a default-attribute canvas drawing only `willReadFrequently` scratch canvases returned the GPU result for reads 1 and 2 and the CPU result for reads 3 and 4.
- Upgrade on drawImage. If a CPU canvas draws an image from a GPU-backed source, "Recreate the canvas in GPU raster mode" runs ([html_canvas_element.cc#1840](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc#1840)). The check doesn't look at `willReadFrequently: true`, so a `willReadFrequently` canvas that draws a default-attribute scratch canvas gets upgraded. In my test the first frame started on CPU and switched to GPU at the `drawImage` call, and every later frame ran fully on GPU.

Both paths disappear when every canvas uses `willReadFrequently: true`, or when `--disable-accelerated-2d-canvas` is set. Under either, all four draw-and-read cycles in every browser returned the CPU result.

### Browser build

Skia changes between Chromium releases. Chromium 140 and Chromium 151, both on CPU raster, differed in 1,192 pixels, with a maximum delta of 58. Each Playwright release pins one Chromium revision, and 1.55.0 maps to revision 1187, which is Chromium 140.0.7339.16 ([playwright-core browsers.json at v1.55.0](https://github.com/microsoft/playwright/blob/v1.55.0/packages/playwright-core/browsers.json)). A Playwright upgrade is therefore a rendering change.

### CPU architecture, CPU features, and OS

Skia's CPU pipeline has per-ISA code that rounds differently. On arm64 NEON, `div255` is exact. Everywhere else it uses a formula "never wrong by more than 1" ([SkRasterPipeline_opts.h#5403 at Chromium 140's Skia revision](https://skia.googlesource.com/skia/+/04e13e2c7a4fed96a31ee10901e382d887d980ae/src/opts/SkRasterPipeline_opts.h#5403)). Multiply-add fuses on arm64 and AVX2 but not on SSE ([#238](https://skia.googlesource.com/skia/+/04e13e2c7a4fed96a31ee10901e382d887d980ae/src/opts/SkRasterPipeline_opts.h#238), [#591](https://skia.googlesource.com/skia/+/04e13e2c7a4fed96a31ee10901e382d887d980ae/src/opts/SkRasterPipeline_opts.h#591), [#798](https://skia.googlesource.com/skia/+/04e13e2c7a4fed96a31ee10901e382d887d980ae/src/opts/SkRasterPipeline_opts.h#798)). On x86, Skia picks the AVX2 path at runtime when the CPU supports it ([SkOpts.cpp#51](https://skia.googlesource.com/skia/+/04e13e2c7a4fed96a31ee10901e382d887d980ae/src/core/SkOpts.cpp#51)). The consequence is that an Apple Silicon Mac and an x86 Linux CI runner won't match, and two x86 machines with and without AVX2 may not match either.

`--disable-skia-runtime-opts` skips `SkGraphics::Init()`, which leaves Skia on the build's baseline code path ([content/common/skia_utils.cc#30](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/content/common/skia_utils.cc#30), [content_switches.cc#242](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/content/public/common/content_switches.cc#242)). That fixes the x86 AVX2 split. It can't make arm64 match x86.

Text goes through each OS's font stack, and the headless shell's `--font-render-hinting` "affects Skia rendering" ([headless/public/switches.h#77](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/public/switches.h#77)). Chromium itself checks in separate pixel baselines per OS version and per CPU architecture, such as `mac-mac15` and `mac-mac15-arm64` ([web test baseline fallback](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/testing/web_test_baseline_fallback.md), [web_tests/platform](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/web_tests/platform/)). I couldn't test x86 because Rosetta isn't installed on this machine. That part rests on the source alone.

### Canvas element versus OffscreenCanvas

On the same CPU path, an `HTMLCanvasElement` and an `OffscreenCanvas` differed in 1,315 pixels, all on the edge of one `clip()` circle. Clip antialiasing defaults to off in the shared recorder ([canvas_2d_recorder_context.h#466](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/modules/canvas/canvas2d/canvas_2d_recorder_context.h#466)). Only the element's context turns it on, through a document setting ([canvas_rendering_context_2d.cc#189](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc#189)). The render page and the embed must use the same kind of canvas. Ticket 02 may care too, since clips on an OffscreenCanvas are hard-edged.

### Colour spaces and display profiles

The canvas backing store has its own colour space, `srgb` by default. The spec applies "Color space conversion ... when rendering the canvas to the output device" ([HTML 4.12.5.4](https://html.spec.whatwg.org/multipage/canvas.html#colour-spaces-and-colour-correction)). `getImageData` returns pixels converted from the canvas colour space to the ImageData's colour space, which defaults to the canvas's ([HTML 4.12.5.1.16](https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation)). With an sRGB canvas, the display profile never touches `getImageData`, `toBlob`, or `toDataURL`. A `display-p3` canvas does change the numbers. `#e63946` read back as `230,57,70` from an sRGB canvas and `212,73,76` from a P3 one.

Screenshots do see the display profile. `--force-color-profile=srgb` makes Chromium treat every monitor as sRGB ([ui/display/display_switches.cc#23](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/ui/display/display_switches.cc#23)). Playwright always passes it ([chromiumSwitches.ts at v1.55.0](https://github.com/microsoft/playwright/blob/v1.55.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts)). When I removed it, a headed screenshot differed from the canvas in 1,972,230 pixels, up to 85 levels. The headless shell has no display, so there the flag made no difference.

### devicePixelRatio

The canvas bitmap is sized by the `width` and `height` attributes, and serialization emits "one image pixel per coordinate space unit" ([HTML 4.12.5.5](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)). DPR changes nothing in readback unless our own code scales the backing store. It does change screenshots. With `deviceScaleFactor: 2` the canvas screenshot came back 3840 by 2160, and Playwright's screenshot `scale` defaults to `"device"` ([Playwright types, page.screenshot scale](https://playwright.dev/docs/api/class-page#page-screenshot-option-scale)).

### Premultiplied alpha

Canvas bitmaps must use premultiplied alpha, and converting to and from it "is a lossy operation on colors that are not fully opaque" ([HTML 4.12.5.7](https://html.spec.whatwg.org/multipage/canvas.html#premultiplied-alpha-and-the-2d-rendering-context)). `getImageData` round trips carry the same warning ([HTML 4.12.5.1.16](https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation)). Opaque pixels are exact. In Chromium 140, `toDataURL` unpremultiplies with `readPixels` first ([image_data_buffer.cc#66](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/platform/graphics/image_data_buffer.cc#66)), while `toBlob` hands the pixmap straight to the encoder. Even so, on a canvas with 1.4 million translucent pixels, all three readbacks agreed exactly. That is observed behaviour, not a guarantee, so keep exported frames opaque.

### PNG encoding

PNG is lossless. The spec requires `image/png` support and says formats that carry colour profiles must be tagged with the bitmap's colour space ([HTML 4.12.5.5](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)). Chromium writes no colour chunk for an sRGB canvas, which comes to the same thing because an untagged image is sRGB by rule ([CSS Color 4, 3.5](https://drafts.csswg.org/css-color-4/#untagged)). A P3 canvas gets an `iCCP` chunk. The file bytes aren't stable, though. Chromium 140 encodes with the Sub filter at zlib level 3 ([image_encoder.cc#60](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/platform/image-encoders/image_encoder.cc#60), [canvas_async_blob_creator.cc#609](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc#609)), and those are implementation choices. For an `alpha: false` canvas, `toBlob` wrote an RGB PNG (colour type 2) and `toDataURL` wrote RGBA (colour type 6), so the files differed while the decoded pixels were equal. Compare decoded pixels only.

### Smaller hazards

- Canvas noise. Chromium 140 can add fingerprinting noise to readbacks, but only when the intervention is force-enabled and the snapshot is GPU-backed ([canvas_interventions_helper.cc#41](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/third_party/blink/renderer/core/canvas_interventions/canvas_interventions_helper.cc#41)). A CPU canvas avoids it.
- JavaScript math. `Math.sin`, `Math.exp`, `Math.pow` and their siblings are "not precisely specified", and engines choose their own approximations ([ECMA-262 21.3.2](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-function-properties-of-the-math-object)). Geometry computed in V8 can differ from Firefox or Safari before any pixel is drawn. Within one V8 build it is stable.

## Which capture method returns the exact pixels

`getImageData` reads the output bitmap directly, as unpremultiplied RGBA in the requested colour space, so it serves as the reference. `toBlob` and `toDataURL` with `image/png` decoded to exactly the `getImageData` bytes in all 16 configurations I ran. A page screenshot matched too, but only in these runs because every one of them used DPR 1, a canvas with no CSS scaling, and Playwright's forced sRGB profile. Change any of the three and it breaks, and the M1 viewer CSS-scales its canvas by design. Page screenshots are the wrong tool for exports.

Rough cost per 1920 by 1080 frame in the headless shell on the M1 Pro, with a deliberately heavy test frame:

| Step | ms per frame |
| --- | --- |
| Draw only | 32 |
| Draw, `toBlob` PNG, send bytes to Node | 118 |
| Draw, `getImageData`, send raw RGBA to Node as base64 | 139 |
| Draw, `getImageData`, SHA-256 in the page | 65 |

The PNG was about 1.9 MB against 8.3 MB of raw RGBA, so `toBlob` is also the cheaper way to move a frame out of the page.

## Flags

| Flag | What it does | Use it? |
| --- | --- | --- |
| `--disable-accelerated-2d-canvas` | Turns off GPU 2D canvas. `ShouldAccelerate()` returns false, which also blocks the drawImage upgrade ([content_switches.cc#77](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/content/public/common/content_switches.cc#77)) | Yes. This is the flag that pins the rasterizer |
| `--disable-skia-runtime-opts` | Keeps Skia on the build's baseline CPU path | Yes. Needed on x86, a no-op on arm64 |
| `--force-color-profile=srgb` | Treats every display as sRGB. Affects screenshots, not readback | Playwright already adds it |
| `--disable-gpu` | Disables GPU hardware acceleration ([content_switches.cc#136](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/content/public/common/content_switches.cc#136)). Also gave the CPU result in full Chromium | Optional. It adds nothing beyond the flag above |
| `--disable-gpu-rasterization` | CPU raster for compositor tiles, which is page content, not canvas ([gpu_switches.cc#9](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/gpu/config/gpu_switches.cc#9)) | Not needed |
| `--use-angle=swiftshader` | Runs the GPU process on SwiftShader, which enables accelerated canvas there | No. Gave a third, different result |
| `--enable-gpu` in the headless shell | Uses the real GPU ([headless/public/switches.h#63](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/public/switches.h#63)) | No |
| `--deterministic-mode` | Enables begin-frame control plus compositor flags, so frames are issued over DevTools ([command_line_handler.cc#41](https://chromium.googlesource.com/chromium/src/+/refs/tags/140.0.7339.16/headless/lib/browser/command_line_handler.cc#41)) | No. It only affects frame timing, and canvas readback doesn't wait for the compositor |
| `--force-device-scale-factor=1` | Overrides DPR | Not needed. Set `deviceScaleFactor: 1` on the Playwright context |

Chromium's own pixel-test runner pins the same things. It uses SwiftShader, `--force-device-scale-factor=1.0`, `--disable-gpu-rasterization`, `--force-color-profile=srgb`, and `--disable-skia-runtime-opts` with the comment "We want stable/baseline results when running web tests" ([web_test_browser_main_runner.cc on main](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/web_test/browser/web_test_browser_main_runner.cc)).

## Experiments

All experiments ran in a temp directory outside the repo with `playwright@1.55.0` and `pngjs`. The test page drew one deterministic 1920 by 1080 frame with Bezier blobs at fractional transforms, linear and radial gradients, dashed hairlines, a shadow blur, an antialiased clip with `multiply`, a `blur()` filter, `drawImage` of a 64 by 64 scratch canvas with smoothing, and `sans-serif` text. Each configuration drew the same frame and read it four times on one canvas, then drew it again on a fresh canvas and captured it with `toDataURL`, `toBlob`, and an element screenshot.

Result hashes:

- A is `2c53`, Skia CPU raster in Chromium 140.
- G is `c1d0`, Graphite on Metal. Chromium 140 and 151 gave the same G.
- S is `c7ed`, Graphite on SwiftShader.
- M is `86b1` or `09ff`, a frame that started on CPU and was switched to GPU mid-draw.
- B is `d4b8`, Skia CPU raster in Chromium 151.

| Browser and flags | 2D canvas status | Default canvas, reads 1 to 4 | wRF canvas drawing a default scratch canvas | Every canvas wRF |
| --- | --- | --- | --- | --- |
| Headless shell 140 | unavailable_software | A A A A | A A A A | A |
| Headless shell 140, `--disable-gpu` | unavailable_software | A A A A | A A A A | A |
| Headless shell 140, `--enable-gpu` | enabled, Metal | G G M M | M G G G | A |
| Headless shell 140, `--enable-gpu --disable-accelerated-2d-canvas` | disabled_software | A A A A | A A A A | A |
| Headless shell 140, `--use-angle=swiftshader` | enabled, SwiftShader | S S M M | M S S S | A |
| Full Chromium 140, new headless | enabled, Metal | G G M M | M G G G | A |
| Full Chromium 140, new headless, `--disable-gpu` | unavailable_software | A A A A | A A A A | A |
| Full Chromium 140, headed | enabled, Metal | G G M M | M G G G | A |
| Full Chromium 140, headed, `--disable-accelerated-2d-canvas` | disabled_software | A A A A | A A A A | A |
| Chromium 151, headed | enabled, Metal | G G M M | M G G G | B |
| Chromium 151, headed, `--disable-accelerated-2d-canvas` | disabled_software | B B B B | B B B B | B |

wRF means `willReadFrequently: true`. The A result held across more than 15 separate browser launches, in the headless shell, in new headless, and in a headed window.

Other measurements:

- A versus G. 985,454 pixels differ, maximum 136.
- A versus B, CPU raster in Chromium 140 versus 151. 1,192 pixels differ, maximum 58.
- Element versus OffscreenCanvas on CPU. 1,315 pixels differ, maximum 70, all at the clip edge.
- `toDataURL` and `toBlob` versus `getImageData`. Zero pixels differ in every configuration, including the translucent canvas.
- Element screenshot versus `getImageData`. Zero at DPR 1 with forced sRGB. A 3840 by 2160 image at DPR 2. 1,972,230 pixels differ in a headed window without forced sRGB.

## Recommendation for M3

1. Launch the headless shell with Playwright's default `headless: true` and `args: ["--disable-accelerated-2d-canvas", "--disable-skia-runtime-opts"]`. Leave Playwright's `--force-color-profile=srgb` in place. Create the context with `viewport` equal to the scene size and `deviceScaleFactor: 1`.
2. Pin Playwright to an exact version in `package.json`, with no caret. `1.55.0` reuses the cached Chromium 140 build. Treat any upgrade as a re-render of every reference image.
3. Give the engine one function that creates every 2D context: the visible canvas, the ID pass, and any scratch canvas. Use `{ willReadFrequently: true, colorSpace: "srgb" }`. Use `HTMLCanvasElement` everywhere, or `OffscreenCanvas` everywhere, never a mix. The flag covers the headless render. The attributes cover the viewer and the embed, and they stop the drawImage upgrade.
4. Render mode sizes the canvas bitmap to the scene size and applies no DPR transform. CSS scaling is fine because it doesn't touch the bitmap.
5. Keep frames opaque. The background layer should paint the whole canvas on every frame.
6. `renderFrame(n)` draws synchronously. The capture script then calls `canvas.toBlob(cb, "image/png")` in the page, moves the bytes to Node, and writes them unchanged. Don't use `page.screenshot`.
7. The determinism test renders frame N by seeking and by sequential playback in the same browser, reads both with `getImageData`, and hashes them in the page. On a mismatch it pulls both buffers and writes a diff image. It compares RGBA bytes, never PNG files.
8. MP4 and GIF take the same PNGs. Pixel exactness ends at the PNG, because H.264 4:2:0 and GIF palettes are lossy by design.
9. Committed golden images only hold for one OS and CPU architecture. The determinism test compares two renders from the same run, so it doesn't need goldens. Any future golden-image test on CI should generate its references on the CI platform.

## What the M4 embed comparison must control for

- Same browser and flags. Open the embed file in a new page of the same Playwright launch that produced the reference frames, so the binary, flags, machine, and fonts all match. Don't use the user's Chrome or another Chromium version. Block network access in that context, which M4 needs anyway.
- Same context setup. The embed creates its contexts through the same engine function and draws at the scene's native resolution. It must never size the bitmap from the container or from `devicePixelRatio`.
- Frame selection. Pause the autoplay loop, call `seek(n)`, and have `seek` draw synchronously. Then read the embed canvas with `getImageData` in the same `evaluate`.
- Comparison. Decode the M3 PNG to RGBA, or better, read the render page's `getImageData` for frame N in the same run. Compare with zero tolerance. Don't compare file bytes or screenshots.
- Same canvas type. If render mode uses a `<canvas>` element, the embed does too.
- Scope of the claim. The match holds for pinned Chromium with CPU raster on the test machine. In a user's Chrome with GPU raster, roughly half the pixels will be off by one level and edges will differ. Firefox and Safari use different rasterizers and math libraries. Text drawn with system fonts will differ across machines. The M4 acceptance line should say which of these it covers.
- Performance check. `willReadFrequently: true` puts the shipped embed on CPU raster, which is closer to the export but may be slower. The test frame took 32 ms to draw on the M1 Pro. M4 should measure playback on a real scene. If CPU raster can't hold the scene fps, the embed can drop the attribute. The comparison still runs on CPU because of the launch flag.

## Not verified

- An x86 run. The claim that arm64 and x86 differ, and that `--disable-skia-runtime-opts` fixes the AVX2 split, rests on Skia and Chromium source. Rosetta wasn't installed, so I couldn't run an x86 build.
- Linux and Windows headless shells. I expect the same rules with different absolute pixels, but only macOS arm64 was tested.
- Whether canvas noise or the readback heuristics changed after Chromium 140. The noise call site is gone from `base_rendering_context_2d.cc` on Chromium main, and I didn't trace where it moved.
