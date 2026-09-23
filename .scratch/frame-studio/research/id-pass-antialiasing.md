# How can the ID pass read exact layer colours when Canvas 2D antialiases every path?

Research for ticket [02](../issues/02-id-pass-antialiasing.md), consumed by M2 ([06](../issues/06-m2-character-rig-and-hit-testing.md)). Checked 2026-09-22 against the WHATWG HTML Standard and the `main` branches of Chromium and Skia. Experiments ran in two browsers. Playwright's headless shell is Chromium 140.0.7339.16 and rasterizes canvas on the CPU. Chromium 151.0.7880.0 runs headless with a GPU canvas, and its `chrome://gpu` page reports "Canvas: Hardware accelerated" with Skia Graphite.

## Question

`hitTest` was planned as a flat-colour ID pass. It re-renders the frame with each layer and part filled in a unique colour, then reads the pixel under the cursor. Canvas 2D antialiases paths, so an edge pixel blends two ID colours into a third colour that may belong to no layer, or to the wrong one. What do the spec and Chromium offer, which decoding scheme gives the right layer at edge pixels, and can premultiplied alpha or colour management change a flat fill's RGB on readback?

## Short answer

Nothing in the spec or in Chromium turns off path antialiasing. `imageSmoothingEnabled` only affects images and patterns. `willReadFrequently` only moves the canvas to the CPU. An SVG alpha-threshold `filter` gives hard edges, but it shifts colours by one step and does nothing on an `OffscreenCanvas`. Snapping only helps axis-aligned rectangles.

Opaque pixels of a flat sRGB fill on an `srgb` canvas read back exactly. Pixels with partial alpha do not, because the bitmap is stored premultiplied, and a `display-p3` canvas changes every value.

So don't decode colours at all. For M2, render each layer on its own into a 1x1 `OffscreenCanvas` translated so the clicked pixel lands at (0, 0). Draw the layers top to bottom through the same `drawLayer` function the visible render uses, and read only the alpha. Pick the layer that contributes most to the visible pixel. For parts, re-draw the winning layer once with a `part()` hook that reads and clears the pixel at each part boundary. In my tests this cost 0.2 to 0.7 ms per click for 41 layers at 1920x1080. It never returned a layer that was absent from the clicked pixel. It agreed with the visible render on 93 to 98 percent of edge pixels across the plain and mixed test scenes, and on 100 percent of interior pixels. The flat-colour ID pass with dense IDs returned a layer that wasn't there on half of all edge pixels.

## Findings

### Canvas 2D has no switch for path antialiasing

The spec never defines coverage. The drawing model says to "render the shape or image onto an infinite transparent black bitmap" and composite it [S1]. The only mention of antialiasing is a non-normative note that it "can similarly be implemented using oversampling" [S2]. The settings dictionary has `alpha`, `desynchronized`, `colorSpace`, `colorType` and `willReadFrequently`, and none of them controls antialiasing [S3].

Chromium hard-codes antialiasing on. `CanvasRenderingContext2DState` calls `setAntiAlias(true)` on its fill, stroke and image paint flags [S10, lines 168 to 178]. The context constructor calls `SetShouldAntialias(true)` [S11, line 215]. `SetShouldAntialias` is C++ only. Neither `canvas_rendering_context_2d.idl` nor the settings IDL exposes it to script [S12].

The spec once had a built-in hit-testing feature, `addHitRegion`. WHATWG removed it in 2016 because no engine had shipped it [S9]. That leaves `isPointInPath` and `isPointInStroke` as the only built-in hit tests.

### What each candidate setting actually does

`imageSmoothingEnabled` controls "whether pattern fills and the drawImage() method will attempt to smooth images" [S4]. In Chromium, setting it only changes the filter quality on the paint flags [S10, `UpdateFilterQuality`, line 799]. In experiment E1, a circle and two rectangles rendered to identical bytes with it on and off: 178 unique colours and 470 partial-alpha pixels either way.

`willReadFrequently` tells the browser to use a software canvas [S5]. Chromium turns it into `RasterModeHint::kPreferCPU` [S14, lines 1729 to 1739]. Without the flag, Chromium logs a console warning on the second `getImageData` and moves an accelerated canvas to the CPU after `kFallbackToCPUAfterReadbacks = 2` readbacks [S13]. The flag keeps antialiasing. It does change which pixels come out partial, because CPU and GPU rasterize edges differently. In Chromium 151, the E1 scene had 413 partial-alpha pixels on the default GPU canvas and 470 on a `willReadFrequently` canvas.

`colorSpace` sets the colour space of the backing store. `getImageData` returns pixels converted from the canvas's colour space to the `ImageData`'s colour space, which defaults to the canvas's own [S6]. Chromium follows this through `GetDefaultImageDataColorSpace` [S13]. See the next section for what this does to ID colours.

`filter` accepts CSS filter functions and `url()` references to SVG filters in the same document [S7]. An `feComponentTransfer` with `<feFuncA type="discrete" tableValues="0 1"/>` thresholds alpha at 0.5, which produces hard edges. It has three problems, all shown in experiment E5.

- It computes on non-premultiplied values [S18], so the unpremultiply rounding comes back at the edges. With `color-interpolation-filters="sRGB"`, the interior stayed exact, but edge pixels drifted by one step per channel. The render had 21 distinct opaque colours for two fills.
- The property's initial value is `linearRGB` [S18]. With the default, every interior pixel of a `#3c9d5a` fill read back as `#3d9d5a`, one step off.
- A same-document `url()` needs a document. On an `OffscreenCanvas`, Chromium accepted the filter string but applied nothing, leaving 436 partial-alpha pixels. The ID pass would also have to replace any `filter` a rig sets itself.

Snapping to whole pixels only works for axis-aligned rectangles. A `fillRect(10, 10, 40, 40)` produced zero partial pixels in E1. Circles, curves, strokes and anything rotated still antialias. That covers every character rig.

`colorType: "float16"` is accepted in Chromium 140, and the `CanvasFloatingPoint` flag is marked stable [S15]. It makes blends more precise but still blends, so it doesn't help.

### Can premultiplied alpha or colour management change a flat fill's RGB?

Fully opaque pixels are safe on an `srgb` canvas. In E3, 2000 random opaque `#rrggbb` fills read back exactly in both browsers, on both the default and the `willReadFrequently` canvas, and with `alpha: false`. For an sRGB CSS colour on an `srgb` canvas, the drawing model's step "Convert the image A to the context's color space" [S1] does nothing.

Partially covered pixels are not safe. The spec requires canvas bitmaps to store premultiplied alpha and calls the conversion "a lossy operation on colors that are not fully opaque" [S8]. The `getImageData` section repeats the warning [S6]. In E4, a single `#3c9d5a` circle over transparent black on a CPU canvas had 436 edge pixels, and 407 of them read back with a different RGB. The worst error was 98 steps at alpha 1/255. 192 pixels drifted even at alpha 128 or above. Konva snaps its hit colours to a grid of 3 for this reason. Its source comment says an edge pixel "is stored premultiplied by its alpha and comes back off by up to one per channel" [S19, `Util.ts` `getHitColorKey`].

`display-p3` changes everything. With a `display-p3` canvas, 1998 of 2000 sRGB fills read back different, by up to 114 steps in P3 values. Asking for `{ colorSpace: "srgb" }` on readback still left 983 of 2000 off by up to 7 steps. Keep the default `srgb` for anything that reads pixels back.

Blends between two opaque ID colours are opaque, so an alpha check can't catch them. In E2, a `#000001` background under a `#000003` circle produced 165 pixels of exactly `#000002`. That is a valid ID for a layer that was never drawn.

### Decoding schemes compared

**Test setup.** The E6 scene is 640x360 with a background and 14 character layers. Each character has three parts: a curved body with a 3 px outline, a two-circle eye, and a 1.2 px antenna. Layers cycle through six kinds: plain, drop shadow, `blur(3px)` filter, clipped, `globalAlpha` 0.35, and an even-odd hole. A second run uses plain layers only, to isolate antialiasing from effects. A third adds a full-frame 20 percent white haze on top.

The reference answer for each pixel is the layer that contributes most to its visible colour. To compute it, I rendered each layer alone at full size on the default canvas, which is GPU in Chromium 151, and composited the alphas. The test sampled 3000 edge pixels, meaning any partial alpha or a change of owner next door, plus 1000 interior pixels. "Wrong layer" counts answers naming a layer that has zero alpha at that pixel in the visible render. Those are unambiguous mistakes.

Results for the plain-layer scene in Chromium 151:

| Scheme | Edge agreement | Wrong layer at edges | Interior agreement | Part agreement at edges |
|---|---|---|---|---|
| 1x1 probe, largest contribution | 92.97% | 0 | 100% | 99.83% |
| 1x1 probe, top-most with alpha above 0.5 | 92.97% | 0 | 100% | not run |
| Full-size CPU probe, clear and read one pixel | 91.33% | 0 | 100% | not run |
| Flat ID pass, dense IDs, exact match | 46.73% | 1516 | 100% | 67.67% |
| Flat ID pass, dense IDs, 3 px ring search | 47.37% | 1544 | 100% | 67.75% |
| Flat ID pass, sparse IDs, exact match | 32.60%, no answer on 2022 | 0 | 98.60%, 14 no answer | 100% |
| Flat ID pass, sparse IDs, 3 px ring search | 75.43% | 64 | 100% | 99.63% |
| `isPointInPath` and `isPointInStroke` on recorded `Path2D` | 93.23% | 0 | 100% | 99.89% |

The CPU and GPU references disagreed with each other on 260 of the 3000 edge pixels, 8.7 percent. A method that reads back from a CPU canvas can't do better than that against a GPU-rasterized visible canvas. The full-size CPU probe agreed with the CPU reference on 100 percent of pixels. The 1x1 probe agreed on 93.33 percent.

In the mixed scene with effects, the probe agreed on 98.33 percent of edge pixels and returned no wrong layers. Dense IDs returned 285 wrong layers at edges and 2 in interiors. Sparse IDs with ring search returned 10 wrong layers at edges and agreed on 67.53 percent. `isPointInPath` agreed on 68.4 percent, with 28 wrong layers at edges and 5 in interiors. The shell run, which is CPU on both sides, gave the same picture.

In the haze scene, the probe agreed on 99.73 percent of pixels. Every ID-pass variant and `isPointInPath` agreed on 0 percent, because the haze won every click.

**Exact pixel with a neighbour-search fallback.** With dense sequential IDs this fails silently. A blend of two IDs is often exactly a third valid ID, so 50 percent of edge pixels decoded to a layer that wasn't there. With sparse random IDs, which is Konva's approach [S19], blends rarely match anything. Exact matching then goes quiet at edges instead of lying. Adding a ring search recovers most answers, but the search can walk onto a neighbour that doesn't touch the clicked pixel: 64 of 3000 in the plain scene. Konva's current code accepts pixels with alpha of 128 or more, snaps colours to a grid, and walks outward ring by ring [S19, `Layer.ts` lines 33 to 37 and 351 to 403]. That is a lot of machinery to recover information the render threw away.

**Sparse encoding so blends are detectable.** Detection works. Any opaque colour that isn't in the codebook is a blend. Resolution doesn't, because telling which of the two layers dominates needs the blend weight, and three-layer corners are worse. Part boundaries inside a layer blend too, which is why sparse exact matching missed 14 interior pixels.

Every flat-colour variant also needs a context proxy that forces the ID colour whenever a rig sets `fillStyle` or `strokeStyle`. The proxy has to discard shadows and `filter` and force `globalAlpha` to 1. Each override is a place where the ID pass stops matching what the user sees. The haze result is the extreme case. A 20 percent overlay becomes an opaque ID fill that covers the frame. Keeping `globalAlpha` instead breaks exact matching. In the mixed scene, that left 798 of 3000 edge pixels with no answer. The proxy also can't recolour `drawImage` of a canvas that a rig cached.

**One layer at a time, reverse z-order, alpha test.** This is the scheme that works. It skips colour entirely. The only question per layer is "how much alpha did this layer leave at this pixel?", and alpha survives premultiplication, colour spaces and blending. The layer draws with its real styles, so shadows, blur, `globalAlpha`, clips, text and `drawImage` all count the way they look. No proxy is needed. It only needs one pixel, so it uses a 1x1 canvas translated by (-x, -y). Skia clips rasterization to that pixel, which makes each layer cheap even with blur and shadows. Fabric.js uses the same idea for `perPixelTargetFind`. It renders the candidate object alone into a small `willReadFrequently` canvas, translated to the pointer, and tests alpha there [S20].

I tested two ways to pick the winner. "Top-most layer with alpha above 0.5" and "largest contribution to the visible pixel" gave the same edge agreement in the plain scene: 92.97 percent. They differ when translucent layers stack. "Largest contribution" computes `share = transmit * alpha` and then `transmit *= 1 - alpha` from the top down. That is the source-over formula, so it picks the layer whose colour dominates the pixel. It can stop as soon as the remaining transmittance can't beat the best share.

**`isPointInPath` and `isPointInStroke` on recorded `Path2D`.** These test geometry at the pixel centre. The spec defines them from the path, the fill rule and, for strokes, the line styles only [S16]. Clip, global alpha, shadows, filters and compositing play no part. Recording requires a proxy that captures every `fill`, `stroke`, `fillRect` and `clip` together with the current transform. Text and images have no path to record. On plain shapes this scheme matched the probe. On clipped layers it returned layers the clip had hidden, and on the haze scene it failed completely.

### Fidelity of the 1x1 probe

The probe doesn't produce exactly the same edge coverage as a full-size render, even on the same CPU backend. In experiment E7, Skia's CPU output was exactly translation-invariant. Shifting a whole canvas by (17, 23) matched on every edge pixel. It was not clip-invariant, though. On a 1x1 canvas, only 7 of 400 edge pixels of an r=80 circle matched the full render, with a worst difference of 91/255 in alpha. A 301x301 canvas that contained the whole path matched all 400.

The Skia source explains it. `aaa_fill_path` builds edges with `builder.buildEdges(path, pathContainedInClip ? nullptr : &clipRect)` [S17, `SkScan_AAAPath.cpp` line 1615]. When the path spills past the device bounds, `SkEdgeBuilder` chops the curves at the clip through `SkEdgeClipper::ClipPath` [S17, `SkEdgeBuilder.cpp` lines 272 to 285]. That changes their line approximation. Clip edges are antialiased as well, since Chromium's `antialiasedClips2dCanvasEnabled` setting starts as `true` [S15].

This only matters on the one-pixel band along each edge, where either neighbouring answer is defensible. The GPU canvas already disagrees with every CPU method on 8.7 percent of those pixels. A full-size CPU probe would remove the clip effect, but not the GPU difference. It also costs as much as a full render. With blur and shadow layers at 1920x1080, that came to about 600 ms per click.

### Cost per click

Experiment E8 used 41 layers at 1920x1080 and took the median of 25 clicks.

| Scheme | Plain layers, shell / Chromium 151 | With shadow, blur and clip layers, shell / Chromium 151 |
|---|---|---|
| 1x1 probe, layers and parts | 0.2 / 0.3 ms | 0.5 / 0.7 ms |
| Flat ID pass on a CPU canvas, 7x7 read | 4.2 / 4.1 ms | 5.7 / 5.4 ms, with effects stripped |
| Flat ID pass on a GPU canvas with `willReadFrequently: false` | 4.2 / 1.4 ms | 5.7 / 1.5 ms |
| `isPointInPath`, record and test | 1.8 / 1.2 ms | 1.8 / 1.5 ms |
| Full-size CPU probe | 3.9 / 3.9 ms | 616 / 596 ms |

The probe runs the draw code for each layer from the top down, stopping early, plus one more pass over the winning layer for parts. Nothing is cached per frame, so hover highlighting pays that cost on every query. At under 1 ms, that fits in a 60 Hz mousemove budget.

## Recommendation for M2

Build `hitTest` as a per-layer alpha probe instead of a flat-colour ID pass. It still meets the goal in CLAUDE.md, "the ID pass uses the same draw code as the visible render so the two can never drift", and meets it more strictly, since the probe calls the draw code with the real context and no style overrides. When M2 lands, rewrite the CLAUDE.md hit-testing paragraph, which says "unique flat colour, no antialiasing", to describe the probe.

1. Factor `render(ctx, scene, frame)` into a loop over one exported `drawLayer(ctx, scene, layer, frame, kit)`. The function handles track and override evaluation, `stepFps` quantization, `save` and `restore`, and the rig call. `hitTest` and the visible render both call it, and neither one draws a layer any other way.
2. Add `part(id, draw)` to what a rig receives, next to `rng` and `stage`, as a `DrawKit`. In the normal render it just calls `draw()`. Rigs wrap each part they declare in `parts` with it.
3. Keep one lazily created `new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })` with the default `srgb`. Widen `Rig.draw`'s context type to `CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`.
4. Clear and read with `putImageData` and `getImageData`. The spec says the clip, transform, global alpha and compositing don't affect the pixel-manipulation methods [S6]. In E9, `clearRect` under a clip that excluded the pixel left it untouched, and `putImageData` of an empty 1x1 `ImageData` cleared it.

```ts
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const EMPTY = new ImageData(1, 1);
const alpha = (c: Ctx2D) => c.getImageData(0, 0, 1, 1).data[3] / 255;

// Layers top to bottom. Stops once nothing below can beat the best share.
for (let i = stack.length - 1; i >= 0; i--) {
  probe.putImageData(EMPTY, 0, 0);
  probe.setTransform(1, 0, 0, 1, -px, -py);          // px, py = floor of scene coords
  drawLayer(probe, scene, stack[i], frame, PASS_THROUGH);
  const a = alpha(probe);
  const share = transmit * a;
  if (share > bestShare) { bestShare = share; best = i; }
  transmit *= 1 - a;
  if (transmit <= bestShare && !opts.all) break;
}

// Parts, winning layer only: each segment between part boundaries gets its own alpha.
const owners: (string | undefined)[] = [];
const segs: [string | undefined, number][] = [];
const cut = () => { segs.push([owners.at(-1), alpha(probe)]); probe.putImageData(EMPTY, 0, 0); };
const kit = { part(id: string, draw: () => void) { cut(); owners.push(id); draw(); cut(); owners.pop(); } };
// Draw once with `kit`, call cut() at the end, then pick the largest share from the last segment back.
```

Return `{ layerId, partId?, candidates }`. `candidates` lists every layer with nonzero alpha at the pixel, top first, with its alpha. With `{ all: true }` the loop skips the early exit. The viewer can then cycle through candidates when the user clicks the same spot again. That matters because "largest contribution" gives a plain click on a layer with opacity below 0.5 to whatever is behind it. That is right for a faint full-frame overlay, and debatable for a character mid-fade.

Rules for rigs, which the probe relies on:

- Never call `setTransform`, `resetTransform` or `reset`. Use `save`, `translate`, `rotate`, `scale` and `restore`. An absolute transform throws away the probe's offset, and the preview's devicePixelRatio scale too.
- Never read `ctx.canvas` for sizes. Use `stage`.
- Avoid compositing modes that read the destination, such as `source-atop` shading or `destination-out` cutouts, across part boundaries. The part pass clears the pixel before each part. A `source-atop` part then draws nothing, and the click goes to the part below. This follows from the compositing definitions. I didn't test it. The layer-level answer is unaffected, because the layer pass doesn't clear between parts.

Tests for M2:

- **Probe parity.** On several frames, including mid-motion ones, render each layer alone at full size. At sampled pixels whose alpha is 0 or 255 in every layer and whose 8 neighbours share the same owner, the probe must return that owner. Skip edge pixels, because they are ambiguous by one pixel and the backends disagree on them. This test catches rigs that break the rules above.
- **Parts.** The same check at part interiors of the character rig.

What M2 gives up, stated plainly:

- **Edge pixels.** Answers on the one-pixel antialiased band can differ from the visible canvas, on 7 percent of edge pixels in the plain scene. No answer ever named a layer absent from the pixel.
- **Cost.** Each click runs the draw code for every layer above the hit, plus one more pass for parts. That was 0.2 to 0.7 ms here, with no per-frame cache.
- **Parts.** Part-level answers assume parts are drawn with source-over.
- **Highlight.** The probe returns ids, not shapes. To outline or tint the selection in the overlay, render the selected layer alone through `drawLayer` into a stage-size offscreen canvas and use its alpha as the mask. That costs one layer render per selection or frame change.

## Experiments

All experiments ran in a temporary directory outside the repo, `/tmp/idpass.vdLy`, with `playwright-core@1.55.0`. That version matches the cached `chromium_headless_shell-1187`, which is Chromium 140.0.7339.16. For a GPU-accelerated canvas I pointed `executablePath` at `/Applications/Chromium.app`, version 151.0.7880.0. Nothing in the repo was installed or changed.

- **E1 antialiasing switches.** A circle and two rectangles, with `imageSmoothingEnabled` and `willReadFrequently` each on and off. Byte-identical on the CPU. GPU and CPU differ in Chromium 151. An integer-aligned rectangle has zero partial pixels.
- **E2 dense ID collision.** A `#000001` rectangle under a `#000003` circle gives 165 pixels of exactly `#000002`.
- **E3 colour fidelity.** 2000 random opaque fills per canvas configuration. Exact on `srgb` and `alpha: false`. On `display-p3`, 1998 of 2000 differ, or 983 of 2000 when read as `srgb`.
- **E4 premultiplied round trip.** 407 of 436 edge pixels drift in RGB, by up to 98 steps.
- **E5 SVG discrete-alpha filter.** Hard edges, but colours drift and `OffscreenCanvas` ignores the filter.
- **E6 decoding accuracy.** The tables above.
- **E7 1x1 versus full-size coverage.** The probe is translation-invariant but not clip-invariant.
- **E8 cost per click.** The timing table above.
- **E9 clearing under clip.** `clearRect` leaves the pixel when a clip excludes it. `putImageData` clears it.

## Sources

- [S1] HTML Standard, 4.12.5.1.22 Drawing model. https://html.spec.whatwg.org/multipage/canvas.html#drawing-model
- [S2] HTML Standard, 4.12.5.1 The 2D rendering context, note on oversampling. https://html.spec.whatwg.org/multipage/canvas.html#2dcontext
- [S3] HTML Standard, `CanvasRenderingContext2DSettings` IDL and 4.12.5.1.2 The canvas settings. https://html.spec.whatwg.org/multipage/canvas.html#the-canvas-settings
- [S4] HTML Standard, 4.12.5.1.18 Image smoothing. https://html.spec.whatwg.org/multipage/canvas.html#image-smoothing
- [S5] HTML Standard, will read frequently. https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently
- [S6] HTML Standard, 4.12.5.1.16 Pixel manipulation, `getImageData` steps, the lossy-conversion note, and "the clipping region ... must not affect the methods described in this section". https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation
- [S7] HTML Standard, 4.12.5.1.20 Filters. https://html.spec.whatwg.org/multipage/canvas.html#filters
- [S8] HTML Standard, 4.12.5.7 Premultiplied alpha and the 2D rendering context. https://html.spec.whatwg.org/multipage/canvas.html#premultiplied-alpha-and-the-2d-rendering-context
- [S9] whatwg/html PR #1942, "Remove canvas element's hit region feature (for now)", merged 2016-10-21. https://github.com/whatwg/html/pull/1942
- [S10] Chromium `third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d_state.cc`: `setAntiAlias(true)` at lines 168 to 178, `SetShouldAntialias` at 318, `UpdateFilterQuality` at 799. https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d_state.cc
- [S11] Chromium `canvas_rendering_context_2d.cc`, constructor `SetShouldAntialias(true)` at line 215, fetched at commit a17261155067. https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc
- [S12] Chromium `canvas_rendering_context_2d.idl` and `canvas_rendering_context_2d_settings.idl`. Neither exposes antialiasing. https://github.com/chromium/chromium/tree/main/third_party/blink/renderer/modules/canvas/canvas2d
- [S13] Chromium `base_rendering_context_2d.cc`, `getImageData` readback warning and CPU fallback at lines 480 to 533, and `base_rendering_context_2d.h`, `kFallbackToCPUAfterReadbacks = 2` at line 99. https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc
- [S14] Chromium `third_party/blink/renderer/core/html/canvas/html_canvas_element.cc`, `RasterModeHint` from `will_read_frequently` at lines 1729 to 1739. https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc
- [S15] Chromium `runtime_enabled_features.json5`, `CanvasFloatingPoint` status `stable`, and `core/frame/settings.json5`, `antialiasedClips2dCanvasEnabled` initial `true`. https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/runtime_enabled_features.json5 and https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/frame/settings.json5
- [S16] HTML Standard, 4.12.5.1.13 Drawing paths to the canvas, the "is point in path" and "is point in stroke" steps. https://html.spec.whatwg.org/multipage/canvas.html#drawing-paths-to-the-canvas
- [S17] Skia `src/core/SkScan_AAAPath.cpp`, `aaa_fill_path` and `AAAFillPath`, and `src/core/SkEdgeBuilder.cpp`, `SkEdgeClipper::ClipPath`, at commit a8b9d3dd1881. https://github.com/google/skia/blob/main/src/core/SkScan_AAAPath.cpp and https://github.com/google/skia/blob/main/src/core/SkEdgeBuilder.cpp
- [S18] Filter Effects Module Level 1, `feComponentTransfer`, which says "The calculations are performed on non-premultiplied color values", and `color-interpolation-filters`, whose initial value is `linearRGB`. https://drafts.csswg.org/filter-effects-1/#feComponentTransferElement and https://drafts.csswg.org/filter-effects-1/#propdef-color-interpolation-filters
- [S19] Konva `src/Layer.ts`, `getHitShape` and `getIntersection`, and `src/Util.ts`, `getHitColorKey`, at commit 2e49f73cb009. https://github.com/konvajs/konva/blob/master/src/Layer.ts and https://github.com/konvajs/konva/blob/master/src/Util.ts
- [S20] Fabric.js `packages/core/src/canvas/SelectableCanvas.ts`, `isTargetTransparent` and the `willReadFrequently` pixel-find canvas, and `packages/core/src/util/misc/isTransparent.ts`, at commit e009409980c1. https://github.com/fabricjs/fabric.js/blob/master/packages/core/src/canvas/SelectableCanvas.ts
