# Progress

Last updated 2026-09-23, after the M4 review.

## Done

### M1: Engine and viewer

M1 is built and its four acceptance criteria pass. Three agents built the engine, the rigs and the viewer in parallel against one shared contract, and an integration pass then checked the parts against each other. Typecheck, tests and build were already green when the parts met, so the integration pass found no mismatched names or signatures to fix.

What M1 delivered:

- Project setup. Vite, strict TypeScript and Vitest, with the folder layout from `CLAUDE.md`. `package.json` has no runtime dependencies. The dev dependencies are typescript, vite and vitest.
- The engine in `src/engine`. It covers frame and time maths, `stepFps` quantization, `MM:SS:FF` timecode, 19 named easings, a seeded RNG with keyed forks, track evaluation, override ranges, a rig registry, layer resolution, `render` and scene validation. Everything is re-exported from `src/engine/index.ts`. A throwaway Vite library build put the engine at about 17 KB minified (6 KB gzipped), validator included.
- Four rigs in `src/rigs`. `paper` is the background. `circle`, `rect` and `star` share position, scale, rotation, fill, stroke, opacity and a seeded hand-drawn `wobble`. The wobble changes only when the layer's quantized time changes.
- Two scenes. `scenes/shapes-test.json` is the M1 test scene and `scenes/hello.json` is the smallest working example. `docs/SCENES.md` documents the scene format and every rig param.
- The viewer in `src/viewer`. The canvas fits the window and its backing store follows devicePixelRatio. The HTML controls are play/pause, a scrubber, frame step, Home/End, the timecode, the frame number, scene fps next to measured fps, and a scene picker. The URL carries the scene and frame, an error panel lists every problem, and `window.studio` lets an agent drive the page. Scene and rig edits swap in without a reload and keep the frame.

### How each acceptance criterion was verified

1. Scrubbing to any frame shows the same image as playing to it.
   - Tests. `tests/scenes.test.ts` renders every frame of every scene three ways: in order on one context, on a fresh context per frame, and backwards on one context. All three must give identical draw logs. The engine's recording context logs the full drawing state with each paint call, so equal logs mean equal pixels. `src/engine/render.test.ts` covers the same property with rigs that leak state on purpose.
   - Browser. In headless Chromium I played `shapes-test` to frames 8, 15 and 25, paused, jumped elsewhere, then seeked back. The canvas pixel hashes matched every time, and they also matched a sweep that called `renderFrame` on each frame directly.
2. Unit tests cover timecode round-trip, quantization, easing endpoints, track evaluation and override `[from, to)` boundaries. They live in `src/engine/timecode.test.ts`, `time.test.ts`, `easing.test.ts`, `tracks.test.ts` and `overrides.test.ts`. The timecode round-trip runs one hour of frames at several frame rates.
3. Playback holds real-time speed at the scene fps.
   - Tests. The clock computes each frame from the play anchor instead of adding up ticks. `src/viewer/clock.test.ts` runs an hour of jittery ticks and checks for zero drift.
   - Browser. After 2.0 s of playback from frame 0 the viewer showed frame 23, with frame 24 due within milliseconds, and the readout said "12 fps · playback 12.0".
4. The engine imports no third-party packages. `tests/runtime-budget.test.ts` scans every non-test script file, of any extension, in `src/engine`, `src/rigs` and `src/audio`. It fails on any import that is not a relative path inside those folders, on wall-clock and unseeded-random APIs such as `Math.random`, `Date`, `performance`, `requestAnimationFrame` and crypto randomness, and on `import.meta.glob`. It also fails if `package.json` gains a `dependencies` field.

Ticket 01 also asked for the scene editing loop to work. When an agent edits a file in `scenes/`, the open viewer shows the change at the same frame. The browser check below confirmed it.

### Visual check

The t3 preview tools had no automation host in this session. I drove the cached Playwright headless Chromium over the DevTools protocol instead, with throwaway scripts kept outside the repo, against `npx vite --port 5317`. The viewport was 1600x1000.

- Frame 0 shows paper, the red `onOnes` circle above the blue `onTwos` circle on the left, the yellow star in the middle, and the green block at the bottom right.
- Frames 10 and 11 are the stepFps pair. The red circle moves between them and the blue one stays put. A pixel probe over the blue circle's row matched on all 36 pairs of `2k` and `2k+1`, and the row changed between every pair.
- Frame 23 shows the blue circle trailing the red one, and the star has stepped to orange.
- Frames 35 and 48 show the block green with a clean outline. Frames 36 and 47 show it pink, wobbly and with a thicker outline. A pixel count of the override pink found it on frames 36 through 47 and on no other frame.
- The paper renders with visible grain, fibres and a vignette. The strip above the shapes had the same pixels on all 72 frames, and its colour varied a little (standard deviation of about 8 per channel), so the paper is not a flat fill.
- All 72 frames of `shapes-test` had different pixels.
- The controls worked:
  - Space played and paused. After 600 ms of play the frame had gone from 0 to 7.
  - ArrowRight, ArrowLeft and Shift+ArrowRight stepped by 1, 1 and 12 frames.
  - End went to frame 71 and Home to frame 0.
  - Clicking the play button toggled playback.
  - Dragging the scrubber to the middle landed on frame 38.
  - Choosing `hello` in the picker switched to 24 fps with 72 frames, and its ball sat at the bottom at frame 12.
  - Reloading `?scene=shapes-test&frame=41` came back on frame 41, and `?frame=00:03:06` resolved to frame 42.
- At a device pixel ratio of 2, the canvas measured 1545x869 CSS pixels over a 3090x1738 backing store. After render the context transform was the viewer's scale of 1.609375, so `render` left the base transform alone.
- Validation errors. I broke `scenes/shapes-test.json` three ways at once: an unknown param `radiuss`, an unknown easing `outBak`, and an override ending at frame 80. The panel listed all three with their paths and a fix hint each. With malformed JSON it showed the parse error with line and column. Restoring the file cleared the panel, frame 40 stayed on screen, and the page never reloaded. I checked the file against a backup afterwards.
- Live edit. Changing the override fill in the scene file turned the block cyan on frame 40 without a reload.

### Deliberate deviations from `CLAUDE.md`

These were agreed in the shared contract before the build started.

- `Rig.draw` takes a fifth argument, `stage`, which is `{ width, height }` in scene pixels. Backgrounds need the scene size, and `ctx.canvas` is the wrong source because the viewer's backing store is not scene size. The rig tests throw if a rig reads `ctx.canvas`.
- `render` takes the rig registry explicitly as `render(ctx, scene, frame, registry)`, so the engine never imports `src/rigs`. The image at frame N is a pure function of scene, frame and registry.
- Tracks are evaluated at the layer's quantized time. A `stepFps` layer therefore holds position, colour and wobble together on held frames.
- Override params beat track values. Params resolve as rig defaults, then layer `params`, then tracks, then the active override. Overrides are chosen by output frame, not quantized time, so `stepFps` does not shift them.

### Additions beyond the contract

All of these are stricter than the contract or add to it. None renames or changes a contract signature.

- `resetContextState` also starts a fresh path and resets newer text and smoothing properties where the browser has them. `render` restores the context even when a rig throws.
- `formatTimecode` throws a `RangeError` on a negative or fractional frame. `parseTimecode` accepts unpadded fields.
- `rng.int` throws on an empty or fractional range, and `rng.pick([])` throws.
- The validator also rejects two tracks for the same param on one layer, duplicate audio ids, and NaN or Infinity as param values.
- The viewer loads scene files as raw text and parses them itself, so a malformed file shows an error for that scene alone. `window.studio` also has `frameCount`, `playing`, `scenes`, `errors`, `canvas` and `selectScene(id)`. `?frame=` accepts `MM:SS:FF` as well as a frame number.
- A scene file must be named after its id, and `tests/scenes.test.ts` checks this.

### Integration pass

- Added `tests/scenes.test.ts`. Every scene must parse and validate against `createDefaultRegistry()` with zero errors, render every frame through the engine recording context with a balanced save stack, and draw each frame identically whether played, seeked or scrubbed backwards. It also holds the `shapes-test` checks from the rigs agent's `src/rigs/scenes.test.ts`, which it replaces. On top of those it checks, at draw-call level, that held frames match, that the paper stays still, and that the override colour is painted on frames 36 to 47 only.
- Added smoke tests to `src/rigs/rigs.test.ts`. Each rig draws with default params, with every param at its minimum, and with every param at its maximum. Each draw must not throw, must return the save stack to zero, must pass only finite numbers to the canvas, and must match a second draw with the same seed.
- Deleted `src/rigs/scenes.test.ts` and `scenes/.gitkeep`.

### Review

A `/code-review` of M1 ran determinism, spec, viewer, tests and authoring lenses. Every confirmed finding is fixed. Each behaviour fix has a test that failed first, and each test-gap fix was checked against the mutant it names. The suite went from 414 to 543 tests. A throwaway library build now puts the engine at about 22 KB minified, 8 KB gzipped, up from 17 KB because of the checks below.

- Validator. Unknown fields are errors at every level, from the scene root down to keys, overrides and audio cues, with a "did you mean" hint. Before, `stepfps` or `easing` rendered wrong with a clean error panel. `background.id` gets its own message. Colour params must be a hex code, a CSS named colour, `none`, or a CSS colour function with balanced parentheses, since a canvas paints an unreadable colour black. Layer ids may not contain `/`. A duration too short for one frame is a validation error instead of a render failure.
- Engine and rigs. `rng.fork` throws on a key containing `/`, which would alias a nested fork's stream. `fill` and `stroke` treat `none` and `transparent` as no paint in any case and with spaces.
- Viewer. A reload lands on the frame on screen. Chromium fixes a reload's URL before `pagehide` runs, so `pagehide` now also stores the frame in sessionStorage and a reload boots from it. Holding Space toggles once. An unknown `?scene=` shows an error instead of silently switching, `?scene=` also matches a file name, and the requested scene opens once its file exists. When two files share an id, the file named after the id keeps it, so a copy of `hello.json` no longer takes over `hello`. A failed hot swap reports as "Hot update failed", and the next good swap clears it. The controls are built before the canvas measures the stage, so the page renders once at load, at the right size.
- Tests. The runtime-budget scan covers `.mts`, `.js` and the other script extensions, plus `Date()`, `new Date`, a destructured `Math.random`, any `performance` member, `document.timeline`, `requestAnimationFrame` and `import.meta.glob`. The easing tests check reference values at 0.25 and 0.75, continuity at both ends and the inOut seam. New tests pin `frameCount`'s epsilon, overlaps between overrides that are not next to each other in the list, and every property `resetContextState` resets. The rig tests list the shape rigs by name, so adding a rig that is not a shape does not break them. The duplicate render-every-frame scene test is folded into the determinism test.
- Docs. `docs/SCENES.md` now covers coordinates, colour syntax, unknown fields, `window.studio`, timecodes and file names in the URL, and writing a rig. The `inBack` description is corrected. `CLAUDE.md` now shows `render(ctx, scene, frame, registry)` and the five-argument `draw`.
- Quantization. `quantizeTime` floored one step low on exact boundaries when `stepFps` had a decimal (360 x 0.7 is 251.99999999999997 in floats). It now adds the same epsilon as `timeToFrame`, and a test sweeps every one-decimal `stepFps` at 12, 24, 25, 30 and 60 fps. The suite is at 544 tests.

### M2: First character rig and hit testing

M2 is built and its three acceptance criteria pass. The character is the painted gouache bear from tickets 13 and 05, not the fly the roadmap names. At the user's request M2 also brought in frame-range picking, which the roadmap had put in M6.

What M2 delivered:

- Rig parts. `Rig.draw` takes a sixth argument, `kit`. A rig that declares `parts` wraps every paint call in `kit.part(id, ...)`. `PASS_THROUGH` draws every part and `onlyParts(ids)` draws a subset. The registry rejects a variant that drops a param or part of its base rig. Four rig rules in `docs/SCENES.md` keep parts independent, and `src/rigs/rig-rules.test.ts` checks them on every rig that declares parts.
- The `bear` rig in `src/rigs/bear.ts`, with the paws in `bear-paws.ts` and the closed-form cycles in `bear-motion.ts`. It has seven parts (ears, body, paws, muzzle, nose, eyes, mouth), four poses, four expressions, seeded blinks and a breath bob. Each part draws from its own RNG fork. The brush, wash and mark helpers live in `src/rigs/parts/paint.ts`.
- The `bear.bandaged` variant. It adds a `plaster` part and draws the base bear unchanged.
- Scenes. `bear-test` is the M2 scene. `bruno` walks in, waves and cheers, and wears the plaster over frames `[48, 72)`. `pip` holds on twos in front of him. `bears` is the approved still. `bears-gouache`, `bears-pastel` and `bears-watercolor` are the ticket 13 studies. Ticket 13 planned to delete them once the bear settled, but the user chose on 2026-09-23 to keep them under `src/rigs/studies/` as material for testing the iteration modal and scoped edits.
- `hitTest(probe, scene, frame, x, y, registry, options)` in `src/engine/hit-test.ts`, using per-layer alpha probes. The deviations below explain why.
- Viewer selection. A click selects the layer under the pointer, a repeat click steps down through the layers painted there, and Alt with a click picks the part. While paused, hover shows a faint outline. The highlight is a tint and outline on an overlay canvas, built from a mask of the layer drawn alone, and nothing touches the scene canvas. I and O mark the frame range, the from and to fields take frame numbers or timecodes, and Escape clears. The URL carries `layer`, `part`, `from` and `to`. `window.studio` gains `hitTest`, `select`, `setRange`, `clearRange`, `selection` and `range`.
- `@napi-rs/canvas` is a new dev dependency, so the engine hit-test tests run against a real raster in Node. Runtime code never imports it, and the runtime-budget test still passes.

A throwaway library build puts the engine at 27 KB minified, 9.4 KB gzipped, up from 22 KB after the M1 review.

### How each M2 acceptance criterion was verified

1. The character looks the same across the scene, including inside the variant's override range.
   - Tests. `src/rigs/bear.test.ts` checks that `bruno` and `pip` each draw the same head, ears, body and muzzle on every frame of `bear-test`, override range included. It checks that `bear.bandaged` draws exactly what `bear` draws plus the plaster, for several param sets. Poses change only the paws, expressions change only the eyes and mouth, and blinks change only the eyes.
   - Browser. At frame 60 `bruno` wears the plaster, and the rest of him matches the base bear.
2. Blinks and cycles are seeded and deterministic. `src/rigs/bear.test.ts` checks that the same `t` gives the same eye state in any order, that the eyes are open at `t = 0`, that blinks stay between one frame and a fifth of frames over 8 s, and that the wave and breath phases come from the seed. `tests/scenes.test.ts` renders every frame of every scene, `bear-test` included, played, seeked and scrubbed backwards, and the draw logs match.
3. Clicking the character, the background and empty space returns the correct layer on several frames, including mid-motion.
   - Tests. `tests/hit-test.test.ts` works on `bear-test` frames 0, 3, 12, 30, 50, 60 and 85. On each frame, every clean pixel of every layer in a full-size render returns its owner. Named points cover `bruno` mid-motion on frame 12 and inside his override on frame 60, `pip`, the paper, and points outside the stage. Interior pixels of `bruno`'s parts return that part on frames 30 and 60.
   - Browser. On frames 0, 20, 40, 55, 70 and 90, fixed points returned `pip/body`, `pip/muzzle` and `background`. A point on the left returned `bruno/body` on frame 0, then `background` once he had walked past it. Clicking `bruno` on frame 60 outlined him in the overlay, showed his tag, and put `layer=bruno` in the URL.

Frame-range picking. I on frame 12 and O on frame 30 gave `[12, 31)`, and typing `00:02:00` into the to field gave `[12, 24)`. The user also tried the viewer by hand and was happy with it.

### Deliberate deviations from `CLAUDE.md` and the roadmap

- `hitTest` uses per-layer alpha probes instead of the flat-colour ID pass. Canvas 2D antialiases every path, so an edge pixel blends two ID colours into a colour no layer owns (ticket 02). Each layer is drawn alone into a 1x1 probe, and the layer with the largest share of the pixel wins. The signature takes the probe and the registry, so the engine never creates canvases or imports `src/rigs`. `CLAUDE.md` and `docs/ROADMAP.md` now describe the probes.
- `Rig.draw` takes a sixth argument, `kit`, for parts. `CLAUDE.md` shows it.
- The first character is the bear, not the fly. M3's acceptance commands name `fly-test`, so M3 should use `bear-test` instead.
- Frame-range picking moved from M6 into M2. M6 keeps the prompt text, reference images and handing the selection to the agent.
- The selection highlight hides during playback and comes back on pause, like hover. The review below explains why.

### M2 review

A `/code-review` at high effort over the M2 engine, rig and viewer files found ten issues. Eight are fixed, one is fixed in the docs, and one is recorded as a known issue. Behaviour fixes with a test failed that test first. The suite went from 837 to 839 tests.

- Part hit testing. `partAt` weighed each draw segment on its own, so a part drawn in several segments could lose to a part with a smaller total. The bear's `body` is drawn in segments around `ears`. It now sums each part's segments. A test rig with part `a` at alpha 0.5 and 0.25 around part `b` at 0.4 returned `b` before the fix and returns `a` now.
- Playback cost. With a layer selected, every frame of playback rebuilt the selection mask: a second draw of the layer, a readback, a threshold pass and the outline. In headless Chromium a seek on `bear-test` took 6.9 ms with nothing selected and 33 to 41 ms with a bear selected. Playback now skips the highlight. In the browser, the overlay was blank while playing and came back on pause, and the selection bar named the layer throughout.
- Hover failure. One hover probe that threw turned hover inspect off on every frame until the next scene swap. It now skips only the frame that failed and clears its notice once a later probe works. `app.ts` has no unit harness, and I did not trigger a throwing rig in the browser, so this fix has no test.
- `expressive()` in `bear.ts` copied the param reader's `integer()`, which read unadjusted values. Nothing calls it on an adjusted key yet, so the fix has no test.
- `selection.ts` had its own `clampFrame`, which turned NaN into NaN. It now uses the one in `clock.ts`, and a test covers non-finite frames.
- `parseFrameParam` in `url.ts` repeated the parsing in `parseFrameText`. It is now built on it and no longer takes a timecode parser as an argument.
- `EVERYWHERE` and the `num`, `col` and `choice` schema helpers were copied across `bear.ts`, `bear-bandaged.ts` and `bear-paws.ts`. They now live in `src/rigs/parts/paint.ts` and `src/rigs/parts/params.ts`. The studies keep their own copies.
- A test named "pip body, override" tested no override, because only `bruno` has one. It is renamed to say `pip` is checked inside `bruno`'s override.
- `CLAUDE.md` still described the ID pass. Fixed in the docs, as above.
- Not fixed. Every hover probe draws every layer in full, with no bounds cull. It measured 5 to 11 ms a probe on `bear-test`, at most once per animation frame and only while paused. A cull needs rigs to declare their bounds, which changes the rig contract, so it is listed under known issues.

### M3: Headless render, MP4 and GIF

M3 is done and its three acceptance criteria pass. Ticket 15 settled the MP4 colour tags, and M3 now writes them.

What M3 delivered:

- Render mode, `render.html?scene=<id>` in `src/viewer/render-main.ts`. It draws at scene size on a canvas made with `{ willReadFrequently: true, colorSpace: 'srgb' }`, and its `window.studio` has `resolveFrame`, `renderFrame`, `pixelHash`, `writePng`, `exportVideo` and `contactSheet`. The types live in `src/viewer/render-api.ts`, so the Node tools can import them.
- `src/export/`, the export code that runs in the page (ticket 14). MP4 is H.264 through WebCodecs, muxed by Mediabunny with `fastStart: 'reserve'`, so the index sits at the front while bytes still stream out. Each frame goes to the encoder as I420, converted with the BT.709 matrix at full range and carrying its colour space, so the file is tagged BT.709 primaries, sRGB transfer and BT.709 matrix at full range in both the VUI and `colr` (ticket 15). GIF uses gifenc's writer with our own palette: the most frequent exact colours plus the quantizer for the rest, a 16 MB lookup table for colour mapping, and unchanged pixels marked transparent. Exporters draw through a `FrameSource` and write to a `ByteSink`, so they never import the engine, and each shell brings its own sink.
- `tools/render/`, run by Node's own TypeScript support. `npm run render`, `npm run export` and `npm run contact-sheet` start Vite on a free port and Playwright's headless Chromium with ticket 03's flags. The page streams bytes back through an exposed function, and each file lands under a `.partial` name that is renamed only on success.
- Mediabunny 1.59.1 and gifenc 1.0.3 are the app's first runtime dependencies, and both are pinned. `tests/runtime-budget.test.ts` now allows exactly those two and checks that only `src/export` imports them. The engine, rigs and audio still import nothing third-party.
- Playwright 1.63.0 is pinned as a dev dependency, which brings Chrome Headless Shell 153 with an OpenH264 encoder. Tool code gets Node types from its own `tsconfig.node.json`, so code under `src` can't reach `process` or `Buffer`.
- `npm run test:browser` runs `tests/browser/render.test.ts`, 18 tests in about 58 s.

On `bear-test`, an MP4 takes 6.9 s to export and a GIF 10.9 s, for 96 frames at 1920x1080. The I420 conversion accounts for 1.5 s of the MP4 time.

### How each M3 acceptance criterion was verified

1. `npm run render -- --scene bear-test --frame 47` writes `out/bear-test/frame-00047.png`, and `--frame 00:03:11` resolves to the same frame. I looked at the PNG. `bruno` waves one frame before his plaster override, and `pip` is shy.
2. `npm run export -- --scene bear-test --target mp4` and `--target gif` write files at 12 fps with the correct duration. ffprobe counted 96 frames in each and read 8.000000 s for both, with `r_frame_rate` 12/1 for the MP4. The browser tests read the MP4 back with Mediabunny: 96 packets, `avc`, 8 s. A range export `[12, 36)` gave 24 packets starting at 0 s and lasting 2 s. ffmpeg decoded frames 0, 47, 60 and 95 above 35 dB PSNR against the rendered PNGs. That check is dev only and skips when ffmpeg is missing. The GIF has 96 frames, loops, and its delays add up to 800 cs. On colour, ffprobe reads the VUI as `pc, bt709, iec61966-2-1, bt709`, and ffmpeg's trace shows `colr` as `nclx: pri 1 trc 13 matrix 1 full 1`. Mediabunny reads the same colour space back. The `#ffa200` ground decodes as 255,162,0 in ffmpeg and in AVFoundation, which is QuickTime's decoder. AVFoundation read the red bear as 242,73,34 and ffmpeg as 243,73,34.
3. The determinism test passes. For every scene in `scenes/`, it hashes every frame's RGBA in order from frame 0, then again in a fresh page, backwards and every seventh frame. The hashes match. A rig that kept a call counter between frames made it fail on 41 of `shapes-test`'s frames. I removed that mutant.

Ticket 03's checks on the new build also pass. The 2D canvas reports `disabled_software`, so it rasterizes on the CPU. PNGs decode to exactly the canvas bytes. A second browser launch draws identical pixels.

The contact sheet for `bear-test` at `--every 6` shows the scene as scripted: `bruno` walks in, the plaster shows on frames 48 to 66 and is gone at 72.

### Deliberate deviations from `CLAUDE.md` and the roadmap

- Exports encode in the page with WebCodecs, Mediabunny and gifenc, not ffmpeg (ticket 14). ffmpeg only checks files in dev.
- The acceptance commands use `bear-test`, since the bear replaced the fly in M2.
- The visible viewer canvas keeps its GPU raster. Render mode alone uses the CPU canvas from ticket 03, because a GPU canvas draws the painted bear about twice as fast in preview. M4's embed-versus-headless comparison runs both in the same headless setup, so that comparison is unaffected.

### M3 review

A `/code-review` at high effort found ten issues, and all ten are fixed. After the colour work, the suite is at 884 unit tests and 18 browser tests.

- A failed export could leave a truncated file at the real path. Output now goes to `<path>.partial` and is renamed only on success. A bad range now leaves nothing.
- Node types were global, so engine code could use `process` or `Buffer` and still typecheck. The tools and browser tests now have `tsconfig.node.json`. A probe file using `process` under `src/engine` fails to typecheck.
- A contact sheet over the canvas size limit failed with an unclear PNG error. `contactSheetLayout` now refuses anything over 16384 px a side, and the message says to raise `--every` or use fewer `--columns`.
- When a shared browser was passed in, a failed first load leaked the page's browser context. It is now closed.
- The CLI checked flags only after starting Vite and Chromium, and its `process.exit` skipped cleanup. Flags are now checked first, in 0.5 s, and errors in a run throw.
- The render page repeated `rangeError` from `selection.ts`, and now uses it.
- The colour mapper's `Map` cache could grow without bound. It is now a 16 MB `Uint8Array`, and GIF export went from 13.1 s to 10.9 s with byte-identical output.
- GIF export allocated a frame-sized buffer and copied each frame's bytes. It now reuses one buffer and passes a view, and `ByteSink` says the exporter may reuse `data` once a write settles.
- The contact sheet labels named specific fonts. They now use `monospace` only.
- Picking a free port and then binding it left a race. Vite now binds port 0 itself.

### M4: Single-file HTML embed

M4 is done and its four acceptance criteria pass. `npm run export -- --scene bear-test --target html` writes one HTML file that draws the scene live. The bundling happens in Node and takes about half a second, with no browser.

What M4 delivered:

- The embed player, `src/embed/player.ts`. It draws on a canvas at scene size, with the same context attributes as the headless renderer, and CSS letterboxes it to fit. It plays on load and loops. `?autoplay=0`, `?loop=0` and `?frame=n` change that. Same-origin pages call `window.studio`, which has `play`, `pause` and `seek`. Pages on other origins send `postMessage` commands, and the embed answers every one with its state, or with an error when it could not do what was asked. When a frame fails to draw, it shows why and refuses to play on.
- The playback clock moved from `src/viewer/clock.ts` into `src/engine/playback.ts`, so the viewer and the embed share it, and it gained a play-once mode. `rigIdsUsed(scene)` in the engine lists the rigs a scene draws with, including each variant's base.
- The bundler, `tools/bundle/embed.ts`. It resolves scene keys with the viewer's own `buildLibrary` and `findEntry`, and validates at export time, so the embed ships no validator. It finds the module that exports each rig the scene uses, and bundles just those with the player into one minified inline script. A plugin strips rig and param description text from the rig modules first, working on the syntax tree Vite's `parseAst` gives, since the player never reads it.
- `src/embed` joins the runtime roots in `tests/runtime-budget.test.ts`. It may import only the engine, rigs and audio. `player.ts` alone may use `requestAnimationFrame` and `performance.now`.

Sizes: `bear-test` is 54.2 KB, `shapes-test` 19.4 KB. The engine and player alone are about 8.5 KB minified. Stripping the descriptions saved 7.5 KB on `bear-test`, 12%, and pixel parity still holds.

### How each M4 acceptance criterion was verified

`tests/browser/embed.test.ts` has 13 tests.

1. The file works opened from disk with the network disabled. The test opens it through a `file://` URL in a context with `setOffline(true)`, and `navigator.onLine` reads false. It plays, pauses, seeks and loops there, and `?loop=0` stops on the last frame.
2. No external requests. The page made exactly one request, for the file itself, and logged no errors. The file contains no URL at all.
3. Its frames match the headless PNG renders pixel for pixel. In the same browser launch, the embed's canvas RGBA hashes equal `render.html`'s on 8 frames of `bear-test` and 9 of `shapes-test`. Those cover both sides of the plaster override and `shapes-test`'s held frames. `render.html`'s pixels in turn equal its PNGs, which M3 checked.
4. The engine portion stays under about 50 KB minified. It measured about 8.5 KB, and the test holds it under 50 KB. Only the rigs a scene uses are bundled: the `bear-test` file has none of the shape rigs and no validator text, and `shapes-test` has no bear.

A host page on another origin, with the embed in an iframe, drove it with `seek`, `play` and `pause`, and got state back each time, plus an error for a `seek` without a number. I also took a screenshot at 720x540. Frame 60 showed letterboxed, with the plaster.

### Deliberate deviations from `CLAUDE.md` and the roadmap

- The embed ships no validator. It trusts the scene it was built from, which was validated at export.
- The embed draws at scene size, so a high-DPI screen scales the bitmap up. That keeps pixel parity with the PNGs. A sharper option could come later.
- The player reads the wall clock, as the viewer does, and the budget test allows it in that one file.

### M4 review

A `/code-review` at high effort found ten issues, and all ten are fixed. The suite is at 894 unit tests and 31 browser tests.

- The bundler printed validation errors as "undefined: undefined", because a hand-written type had drifted from the engine's. It now takes the engine's own types, and a test checks the real message.
- The bundler looked up scenes its own way, so the same `--scene` key could pick a different file for html than for mp4. It now uses `buildLibrary` and `findEntry`, and a test covers an id that doesn't match its file name.
- Rewriting `<!--` everywhere could break a Unicode regex. Scene data now goes in as `JSON.parse` of a string with no `<` in it. `</script` becomes `<\/script`, and any `<!--` or `<script` left stops the build.
- A broken embed still let `play()` start the loop, and a bad `seek` got no reply. Both are fixed and tested.
- The CLI exited before stdout flushed, so a script capturing the output path could get nothing. It now lets the process end on its own.
- Measuring the engine-and-player size cost a second build on every export. It is now opt-in, and the test asks for it.
- The `--from`/`--to` check fired for any command given `--target html`, and `--every` was silently ignored. Both are fixed.
- The wall-clock exemption covered all of `src/embed`. It now covers `player.ts` only.
- A host that started listening after the load message had no documented way to catch up. The `state` command is now documented.

## Next

1. M5, ticket 09: the MCP server. `tools/render/studio.ts` already does what `render_frame`, `render_contact_sheet` and `export` need. Keep one studio warm, since starting Vite and Chromium takes most of a 3.7 s render. `buildEmbed` covers `export(html)`. `update_scene` and `apply_to_selection` need JSON merge patches, validated with readable errors.

## Open questions

- The repo has two test-only fake contexts. `src/engine/testing/recording-context.ts` tracks full canvas state and serves the engine tests, `tests/scenes.test.ts` and the rig smoke tests. `src/rigs/testing/recording-context.ts` logs plain strings, throws on `ctx.canvas`, and serves the older rig tests. Should they merge? The engine one could take an option to throw on `ctx.canvas`.
- The HTML export builds with Vite and Rolldown in Node. Electron's main process is Node, so it can run the same build if it ships Vite, Rolldown's native binary and the rig sources. A browser tab can't run Vite, but the planned backend can, and Rolldown has a WebAssembly build. Which each shell uses is a packaging choice for the shell work (ADR 0001).
- Should the embed offer a sharper high-DPI mode? It would trade pixel parity with the PNGs for crispness on retina screens.
- Only a test enforces the rule that a scene file is named after its id. The viewer now opens a scene by file name too, and gives a shared id to the file named after it, but it does not flag a mismatch. Should the viewer or validator flag one? MCP `get_scene(id)` in M5 will need to map an id to a file.

## Known issues

- URL writes are throttled to one per 400 ms. During playback, or just after switching scenes, `location.search` trails what is on screen until the next write. A reload still lands on the right frame, because `pagehide` stores the frame in sessionStorage and the reloaded page reads it. `pagehide` also flushes the URL, which covers Back and Forward. A copied URL can still be a few frames behind.
- Pausing freezes on the last frame drawn. That frame can be one behind the wall clock if the next animation frame had not fired yet, as in the 23 versus 24 frames seen after 2.0 s.
- `paper` paints black when `tone` is `none`. The validator accepts `none` for every colour param, but a background has no sensible "no paint".
- A rig that calls `save()` without a matching `restore()` leaks state on a real canvas, and `render` cannot detect it. The smoke tests catch this for the shipped rigs. New rigs need the same check, which they get by being added to `allRigs`.
- The selection outline traces every gap where the ground shows through a layer, such as the small triangle between `bruno`'s left ear and his head. It follows the pixels correctly but reads as a stray mark.
- A hover probe draws every layer in full, 5 to 11 ms on `bear-test`. Scenes with many layers or heavier rigs will feel it. A bounds cull would need rigs to declare bounds.
- Browser tests need the headless shell downloaded once (`npx playwright install chromium-headless-shell`). Installing a newer Playwright deletes cached browsers that no installed Playwright uses. On 2026-09-23 that removed the Chromium 140 build ticket 03 used, which had to be reinstalled through Playwright 1.55 in `/tmp`.
