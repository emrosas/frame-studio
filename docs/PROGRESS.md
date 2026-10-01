# Progress

Last updated 2026-09-26, after M10 and the app's icon, updates and redesign.

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

### M5: MCP server

M5 is done and its two acceptance criteria pass. `node tools/mcp/server.ts` is Frame Studio's MCP server over stdio. The repo's `.mcp.json` registers it for Claude Code, where `claude mcp get frame-studio` shows it waiting for approval. `docs/MCP.md` has setup for any agent and the tool reference.

What M5 delivered:

- The nine tools `CLAUDE.md` names: `list_scenes`, `get_scene`, `update_scene`, `list_rigs`, `render_frame`, `render_contact_sheet`, `hit_test`, `apply_to_selection` and `export`. Frames take numbers or timecodes. Render tools return PNGs the agent can see, and write full-size copies to `out/`. `render_frame` previews up to 1280 px wide by default.
- `tools/mcp/workspace.ts`, the logic behind the tools. One watching Vite server serves both sides: the engine, rigs and viewer library code in Node, and `render.html` for Playwright. The studio starts on the first tool that needs pixels, and reloads whenever a file under `src/` or `scenes/` has changed. Tools run one at a time.
- Scene editing in the engine, `src/engine/scene-edit.ts`, with tests. `mergePatch` is RFC 7386, tested against the RFC's own examples. `applyToSelection` splits any override the range partly covers, so an edit inside `bruno`'s plaster range keeps the plaster around it. `formatSceneJson` writes two-space JSON with short objects and arrays on one line. Every scene file was reformatted with it once, with the data checked identical, so later MCP edits make small diffs.
- `update_scene` and `apply_to_selection` validate before saving and write through a `.partial` file. An invalid patch saves nothing and returns the validator's messages. A scene's id can't change, since its file is named after it.
- A selection without a `layerId` covers the whole frame range, as `CLAUDE.md` describes. Its params go to every layer whose rig takes them all. A `partId` is accepted, but params apply to the whole layer.
- Shared Node helpers in `tools/scene-files.ts` (scene loading, `writeFileAtomic`). `buildEmbed` can reuse a running Vite server. `tsconfig.node.json` sets `erasableSyntaxOnly`, so the typecheck catches TypeScript that Node's type stripping rejects.
- The MCP SDK 1.30.1 and zod 4 are pinned dev dependencies. They are tooling and never reach the runtime. zod only describes tool inputs; scenes are checked by the engine's own validator, which stays the one source of truth.

### How each M5 acceptance criterion was verified

`tests/browser/mcp.test.ts` connects a real MCP client over stdio to `node tools/mcp/server.ts`, as an agent does. It works on a copy of `bear-test` at `scenes/mcp-test-<pid>.json`, which is gitignored and removed afterwards. It has 10 tests.

1. From a fresh agent session: list scenes, render a frame, hit-test the character, apply a scoped change over a frame range, re-render, and see the change only inside that range. `list_scenes` shows the copy with 96 frames and the layers `background`, `bruno` and `pip`. `hit_test` at `00:02:06` (760, 900) returns `bruno` and his `body` part. `apply_to_selection` sets `body` to `#3355ff` over frames 12 to `00:02:00`. Re-rendering gives new pixels on frames 12 and 23, and pixels identical to before on frames 11 and 24.
2. All three targets export through MCP. The MP4 has 96 packets and lasts 8 s. The GIF range has 12 frames. The HTML file bundles `bear`, `bear.bandaged` and `paper` and has no URLs. The html export goes first, into an `out/` folder that doesn't exist yet.

The same file also checks the plaster split, a whole-range edit, parallel renders, a rejected invalid patch that leaves the file byte for byte unchanged, readable errors for an unknown scene or an out-of-range frame, and the contact sheet.

### M5 review

A `/code-review` at high effort found ten issues, and all ten are fixed. The suite is at 920 unit tests and 42 browser tests.

- The html export failed when `out/<scene>` didn't exist yet. The shared `writeFileAtomic` creates folders, and the test now starts from a missing folder.
- The SDK runs requests concurrently, but the tools share one page and read, patch and write scene files. Parallel calls could render the wrong scene, start two browsers or drop an edit. Tools now run one at a time, and a test fires four calls at once.
- A failed page load left the workspace thinking the old scene was still loaded. It now forgets until a load succeeds.
- One failed startup was cached, and broke every later call. A failed start is now forgotten.
- A failed export left its file handle open for the rest of the session. `writeViaSink` now closes it either way.
- `apply_to_selection` required a `layerId`, although `CLAUDE.md` says a selection without one means the whole frame range. It now handles that case.
- Frame parsing in `apply_to_selection` was a second copy. It now uses the viewer's `parseFrameText` and `rangeError`.
- `render_frame` rendered twice even when no scaling was needed. It now renders once in that case.
- The html export started its own Vite server. It now reuses the workspace's.
- The write-then-rename pattern and `ROOT` were defined several times. Each now lives in one place.

### M6: Selection-to-prompt in the viewer

M6 is done and its acceptance criteria pass. The viewer's UI moved to Svelte first, then the handoff from ticket 10 (ADR 0003) was built on top.

What M6 delivered:

- **Svelte port (ADR 0002).** The controls, the selection bar and the error panel are now Svelte 5 components, reading a reactive `ViewerUi` state that the App class writes. The App keeps all its logic. Nine viewer browser tests were written against the old DOM first, finding elements by accessible name, and they passed unchanged after the port. The repo moved from TypeScript 7 to 6.0.3, because svelte-check needs TypeScript's JavaScript API and 7 has none. It typechecked with no changes, and `npm run typecheck` now runs svelte-check too.
- **Range loop.** `PlaybackClock.setLoopRange` keeps playback inside a range, and the viewer loops inside its selected range, like in and out points.
- **The handoff protocol**, `src/studio/protocol.ts`: request and selection shapes, and the shared rules. Those are the stalled status, the clipboard line, time-based `canRevert`, and request validation.
- **The queue on disk**, `tools/studio/queue.ts`:
  - Requests are created by hard-linking a temp file and claimed by exclusively creating `NNNN.claim`, so neither can collide.
  - The scene is checkpointed on claim, with its `checkpointAt` time.
  - It handles complete, cancel, requeue, revert and retry.
  - Clearing archives requests, so ids are never reused.
- **The studio server**, `tools/studio/plugin.ts`: a Vite plugin serving `/__studio/` for the queue, the selection and reference uploads. It pushes the queue over Vite's websocket 100 ms after `.frame-studio/requests/` changes, and refuses anything but same-origin JSON.
- **MCP**: `next_request`, `get_request`, `complete_request` and `get_selection`, the `/frame-studio:next` prompt, and the `selection://current` resource.
- **The Requests panel**: a composer that shows the selection it applies to, takes a prompt and images you attach, paste or drop, and sends the request while copying a line to paste into any agent. Below it, the queue shows statuses and summaries, with View, Revert, Try again, Cancel, Requeue and Clear finished. Clicking a request restores its selection. A notice with **View** appears when a request finishes. The viewer keeps `.frame-studio/selection.json` current.
- **The `bear.blush` variant**, made while playing the agent for acceptance 2 (below). Rosy gouache cheeks, with tests like `bear.bandaged`'s.

### How each M6 acceptance criterion was verified

1. Select the background for frames 1 to 14, prompt a change through the agent, and only those frames change. `tests/browser/mcp.test.ts` sends that request as the viewer would. An MCP client session takes it with `next_request`, applies a ground colour over its selection and completes it. Frames 0 and 14 render identical to before, and frames 1 and 13 change. Revert then restores the scene file byte for byte, and frame 1 renders as it did at the start.
2. Select the character, attach a reference image, prompt a redraw, and the agent produces a rig variant applied through an override, with the reference in no scene file or export. I ran the real loop, in the running dev server and the real queue:
   1. In the viewer, selecting pip over [36, 72), attaching `references/bears-reference.png` and sending "Give pip rosy cheeks, painted in the same dry-brush gouache as the reference."
   2. Then, as the agent through MCP: taking it with `get_request(1)`, which claims it and takes the checkpoint.
   3. Writing `bear.blush`.
   4. Applying it with `apply_to_selection` and rendering frames 35 and 48 to check.
   5. Strengthening the params, since pink barely showed on red-orange fur.
   6. Completing the request.

   No scene file names the reference. The HTML, MP4 and GIF exports contain neither its path nor any of its bytes. The viewer showed the request done with the summary, and **Revert** there put `bear-test.json` back exactly as committed.
3. Revert on a finished request restores the scene exactly, and Try again queues the same ask as attempt 2. `tests/browser/handoff.test.ts` drives the viewer against a throwaway queue: it covers the selection file with the click point, Send with a reference upload and the clipboard line, live statuses, the finished notice and View looping the range, Revert byte for byte, Try again with an edited prompt as attempt 2, Cancel, and Clear finished.

The suites are at 966 unit tests and 60 browser tests.

### M6 review

A `/code-review` at high effort found ten issues, and all ten are fixed.

- **Security.** Any website open in the browser could POST to the dev server's `/__studio/` endpoints: queue prompts for the agent, name arbitrary files as references, or revert scenes. The server now refuses requests that aren't same-origin, going by `Sec-Fetch-Site` or `Origin`, and takes JSON only, which forces a preflight on other sites. `checkNewRequest` validates every field, and reference paths must be images directly in `references/`. I checked all four of those defences with curl.
- **Typing in a range field while playing.** The typed text was wiped on every frame, because the reset effect depended on the whole selection object. It now depends only on the range's signature. A new viewer test types during playback.
- **Stuck requests.** A checkpoint that failed, for example on a missing scene, left the claim file behind, so the request could never be claimed again. The claim is now released.
- **Id reuse.** Clear finished deleted request files, so ids came back and an old pasted line could reach a different request. Finished requests are archived instead, and ids count the archive.
- **Revert discarding work.** Revert went by id, which could throw away work from a second agent session or a requeued request. `canRevert` now goes by time: any other request on the scene that was active after the checkpoint blocks it.
- **Stale frame.** The selection file's frame wasn't updated while seeking. It now updates on seek and pause.
- **Startup race.** The first queue fetch could land after a pushed update and roll the panel back. A push now wins.
- **Needless reloads.** The MCP workspace invalidated every module whenever a render switched scenes, and loaded the scene library twice per render. Stamps are now kept per scene file, and the file is passed through.
- **`get_selection`** started Vite just to read a file, and the `/next` prompt and the resource bypassed the one-at-a-time rule. The selection is now read directly, and all three run in turn with the tools.
- **Copied rules.** The reference types and size limit, the queue event name and the target label were written out in several places. They now come from `protocol.ts`.

The MCP server now also checks a scene file's modification time and size before each render. That caught a real race, where a revert from the viewer landed before the watcher reported it.

### M7: Procedural audio

M7 is done and its acceptance criteria pass. It follows tickets 04 and 14, and ADR 0005 records the design: the whole scene's sound renders once, offline, and the viewer, the embed and exports all play or encode that one buffer.

What M7 delivered:

- **Generators**, `src/audio`: `pad` (an ambient chord), `buzz` (an insect buzz whose pitch wanders along a seeded path) and `blip` (a short beep that can repeat). A generator is code plus a param schema, like a rig. Shared pieces:
  - frame-aligned timing: `cueTimes`, `paramTime` and `sourceTime`
  - `mix()`, a tree of two-input gains
  - an envelope, seeded noise and a seeded wander curve
- **Scene audio.** Cues are `{ id, generator, start, end, params }`. The validator checks generator names and params against their schemas, keeps cues inside the scene, and requires an fps that divides 48000 when a scene has audio. `renderSceneAudio` renders the scene at 48 kHz stereo, exactly as long as its frames, seeding each cue from the scene seed and `audio:<cue id>`.
- **Viewer preview.** A speaker button next to play, and M to mute, remembered across reloads. The sound renders when a scene opens or its cues change, and hot-swaps when a generator file changes. `LivePlayback` plays the buffer in step with the clock through `PlaybackClock.position()`, a new playhead with a fraction. It loops with the range and starts over on a seek, a loop change, or drift past 40 ms.
- **MP4 audio.** AAC-LC at 128 kb/s through `AudioEncoder`, or Opus where there is no AAC encoder, interleaved with the video. AAC packets shift back by 2112 samples, so Mediabunny writes the edit list. `src/export/audio-track.ts` then adds the `roll` sample group and trims the audio to the video's length. Opus gets an edit list that trims it too. It does that inside the moov Mediabunny reports, growing into the free space fastStart `'reserve'` leaves, so `mdat` stays put and exports still stream. A range export takes its own slice of the sound. `--silent` leaves it out.
- **Embed audio.** The bundler finds the generators a scene uses, as it does rigs, and bundles only those, with their descriptions stripped. It adds about 7 KB for `audio-test`. The embed renders its sound on load and starts muted, with a speaker button, because browsers allow sound only after a gesture. It takes `mute` and `unmute` messages. Silent scenes and `--silent` exports carry no audio code.
- **MCP**: `list_generators`, and `silent` on `export`.
- **`scenes/audio-test.json`**, 30 fps: blips at 0.5, 1 and 1.5 s that a circle pulses on, a buzz while a star spins, and a pad under the second half.

### How each M7 acceptance criterion was verified

1. Exported MP4 audio aligns within one frame of scene timings. `tests/browser/audio.test.ts` exports `audio-test`, decodes the audio with ffmpeg, and finds each blip's onset within a frame of its frame. The onsets land 5 to 7 samples after the frame boundary, which is the blip's 1 ms rise, for the whole scene, for a range from frame 30, and with Opus forced. ffprobe reads the audio and video at exactly 4.000000 s for both codecs. I also decoded the file with AVFoundation, which QuickTime uses: exactly 192000 samples, with the same onsets. Chrome isn't installed on this Mac, and the headless shell can't decode AAC, so Chromium playback rests on ticket 14's measurement of the same box layout.
2. The same scene renders identical audio twice. The render page's `audioHash()` is the SHA-256 of the rendered float samples, and the test gets the same hash in a second browser launch. A wrapped `AudioNode.prototype.connect` confirms no input in the render gets more than two connections. The unit tests check the same with a fake audio graph for every generator and for a scene mix.
3. The HTML embed plays audio after a user gesture and stays in sync after seeking. `tests/browser/embed.test.ts` opens the `audio-test` embed from disk with the network off. It starts muted with no sound playing. After a click on **Turn sound on**, the sound reaching the speakers is within two frames plus the 40 ms tolerance of the frame on screen, before and after `seek(90)` while playing, and it stops on pause. `tests/browser/viewer.test.ts` checks the same in the viewer, and that M mutes.

The suites are at 1040 unit tests and 75 browser tests, all passing with the committed `bear-test.json`.

### M7 review

Two review agents read the M7 diff: one covered the render and the export, the other playback, the embed and the tooling. The render and export review found nothing serious beyond the Opus gap below. All of these are fixed:

- **A generator that threw while scheduling** threw straight out of `renderSceneAudio` instead of rejecting its promise. That would have stopped the viewer booting, and left an embed blank with no message. The function is async now.
- **Drawing time counted as drift.** The sound was checked against the animation frame's start time, after the draw. On a slow device a draw longer than 40 ms would have restarted the sound almost every frame. The viewer and the embed now read the clock when they update the sound.
- **Every hot edit re-rendered the sound**, because the cache compared generator registries, and every reload builds a new one. It now compares the generator objects the cues use, so only an edit to one of those generators renders again. I checked in the dev server that a generator edit re-renders without a page reload and keeps the frame.
- **Embeds with `loop=0` looped their sound** in a background tab, where animation frames stop. Played once, the sound source now stops by itself at the end.
- **Unmuting from a script, with no click**, marked the embed's sound as on while the browser still held it back. The next click on the speaker then muted it. The embed now reports sound as on only once the browser allows it, and a click while it's held back asks for it again.
- **Touch taps never unlocked sound in the viewer.** A `pointerdown` from touch doesn't count as a gesture. The viewer now also listens for `pointerup` and `click`.
- **Opus files ran 20 ms longer than the video**, since only AAC was trimmed. The patch, now `finishAudioTrack` in `src/export/audio-track.ts`, adds a trimming edit list when Mediabunny wrote none. A browser test forces Opus and checks the length and the blip onsets with ffmpeg.
- **Smaller ones:**
  - Cue ids now reject `/`, as layer ids do, so two cues can't share random numbers.
  - M does nothing on a silent scene or on key repeat.
  - Changing the loop range while playing keeps the time already spent on the frame, so pressing I or O doesn't restart the sound.
  - The blip cap is gone, since blips are at least a frame apart anyway.
  - The render page retries a failed audio render instead of caching the failure.
  - The drift checks after a seek in the browser tests poll instead of sleeping.

### M8: Integrated AI

M8 is built as ticket 16 settled it (ADR 0006), and its acceptance criteria pass. Requests are threads now, and the studio runs Claude and Codex itself, through the CLIs you already have signed in.

What M8 delivered:

- **Threads.** A request is a thread of turns: pending, working, your turn, then settled when you close it (`src/studio/protocol.ts`, `tools/studio/queue.ts`).
  - Each turn saves the scene before its agent starts, and "Revert to here" goes back to any turn.
  - Try again reverts the newest turn and asks again.
  - A per-scene lock file keeps one working thread per scene, even across the dev server and an external MCP server.
  - Request files from before threads read as one-turn threads.
- **Agents in the studio** (`tools/studio/agents/`), run by the studio server:
  - a runner that claims threads for them, starts turns, logs and pushes every event, and marks turns interrupted after a restart
  - access rules
  - three providers: Claude, through Anthropic's Agent SDK pointed at your installed `claude`, with `canUseTool` running the access rules; Codex, through `codex app-server` over stdio, answering its approval requests through the same rules; and a scripted test agent for the browser tests
- **The studio tools over HTTP** at `/__studio/mcp`. The tool definitions moved to `tools/mcp/tools.ts`, so the stdio MCP server and the studio's agents register the same ones. A bearer token per turn tells the studio which thread a call belongs to, so it can apply the scene rules and save rendered frames as thumbnails.
- **The left panel.**
  - An agent picker with model, effort and full access, which says which command fixes an agent that isn't ready.
  - The thread list, and a thread view: your asks, the agent's streamed reply, one line per step, clickable frame thumbnails, approval cards, token use, and Revert to here.
  - A reply box with Settle, Try again, Stop and Cancel.
- **MCP for threads.** `next_request` and `get_request` return the whole thread, `complete_request` ends a turn, and a reply puts the thread back in the queue.
- Tools start Vite with agents off (`startVite`), so only the viewer's dev server claims threads.

### How each M8 acceptance criterion was verified

1. **The Claude loop.** Through the studio server with the real `claude`:
   - A request to make the ball blue over [12, 24) took 20 s. Claude called `apply_to_selection`, retried once after a bad first call, rendered frame 12 to check (the thumbnail was saved), and ended with the summary "Set the ball's fill to blue over frames 12–24". The override landed only on [12, 24).
   - `tests/browser/agents.test.ts` runs the same loop in the viewer with the test agent: streamed text, steps, a clickable frame thumbnail, a reply that resumes the session, Revert to here restoring the scene byte for byte, and Settle.
2. **The same loop with Codex.** With the real `codex` (signed in with ChatGPT), "make the ball green" applied `#39a845` over [12, 24) and rendered frames to check. The reply "now a darker green" resumed the same Codex thread and applied `#267a32`. Getting there found one real problem: Codex asks before each MCP tool call through an elicitation, which the adapter had declined. It now allows the studio's own tools there.
3. **Access.** With the default access, the test agent writes a rig file in `src/rigs/` without a card. Editing a file in `docs/` shows a card, and declining blocks the write. A shell command shows a card. With full access there are no cards. `tests/node/agents.test.ts` checks the rules themselves, and how Claude's and Codex's tools map onto them.
4. **Concurrency.** Two threads on one scene and one on another: the first and third work at once, and the second waits until the first ends.
5. **Interruptions.**
   - Stop keeps the orange the agent had applied and hands the thread back.
   - Closing the dev server mid-turn marks the turn interrupted, and the new server's first reply resumes the agent's session.
6. **External agent.** `tests/browser/mcp.test.ts` works a thread through `next_request`, replies, gets the whole thread back from `next_request` with the first turn and its summary, and completes the second turn. `tests/browser/handoff.test.ts` follows the same in the viewer: reply, Revert to here, Try again, cancel, settle and clear.
7. **Setup.** With `claude` or `codex` missing from PATH, or signed out, their status says so and names the command to run. With a signed-in `claude` it reads as ready. Nothing in the studio asks for credentials.

After the review fixes, real Claude and Codex turns ran again in parallel on two scenes: 12 s and 8 s, each rendering frames to check its edit. The suites are at 1073 unit tests and 82 browser tests, all passing with the committed `bear-test.json`.

### M8 review

Two review agents read the M8 diff, one on the server side and one on the viewer. The server review found real problems, several confirmed by running them. All of these are fixed:

- **Starting agents from outside.** Any local program, or another host when Vite runs with `--host`, could post a request that starts a full-access agent. The studio server now answers only this computer. Claude also had its per-turn token on the `claude` command line, visible in `ps`. Claude now gets the studio tools in-process, and needs no token.
- **The per-scene lock didn't hold.** A lock whose holder was mid-claim read as stale, and an empty lock file read as thread 0. Two claims on one scene both won in 200 of 200 runs.
  - Claims and locks are now written whole and linked into place.
  - A lock is live while its holder's claim file exists.
  - A stale one is renamed aside and checked before it's removed.
  - A new test runs 20 rounds of four simultaneous claims from two queues.
- **A late complete ended someone else's turn.** A turn now ends only for the session and turn that claimed it, and `complete_request` only for external agents' threads. The runner removes only its own run's entry.
- **One missing scene blocked the whole queue.** That thread's turn now fails with the reason, and the threads after it go on.
- **Direct edits to another scene's file skipped the scene rules.** Writing `scenes/other.json` now counts as changing that scene.
- **An open approval card froze every thread's tools.** It waited inside the one tool queue all turns share. It now waits outside it, and calls queued behind it don't run after their turn ends.
- **Codex Stop could be lost or hang during setup.** Stop now works from the first moment, and every setup step races it. The model list has a timeout. Status checks answer from a cache and refresh in the background. The runner also looks for work every 30 s, so an agent that signs in picks up its waiting threads.
- **Smaller ones:**
  - Resumed sessions now get the whole thread, so they hear about reverts.
  - Recovery leaves a live second dev server's turns alone.
  - Orphaned claim files are cleared.
  - Thumbnail names are unique per run.
  - Changes to one thread take turns within the process.
  - Codex's copy of the studio tools has its own server name, and Claude uses only the studio's MCP server.

The viewer review found nothing critical. These are fixed:

- The panel now keys the thread view on the thread, so a draft or Try again no longer carries over to the next thread opened.
- Try again takes the reply box's settings and images, and shows only when the server will allow the revert.
- Turn events live in raw state, are appended rather than re-sorted, and are dropped when their thread is cleared.
- Opening a thread fetches every turn not yet fetched.
- The notice fires for fast turns too.
- An unanswered card says so instead of "Declined".
- Cancel appears when Stop can't reach the turn.
- Reference images show only for real reference paths.
- The agents test waits long enough for real CLIs to answer.

### M9: Projects

M9 is built as ticket 17 settled it (ADR 0007), and its nine acceptance criteria pass. A project is a folder of scenes that share a frame rate, a size and a cast, and a scene can place its siblings, so a longer video is a main scene of shots that can each be worked on at once.

What M9 delivered:

- **Project folders.** `projects/<id>/project.json` holds the name, fps, size, main scene and cast. The library (`src/viewer/library.ts`) builds each project with its own rig registry, checks every scene against the project, and gives project scenes qualified ids, `<project>/<scene>`. A scene that places itself, however indirectly, a scene nested more than 4 deep, and a scene placing a broken one each get an error.
- **Scene layers** (`src/engine/scene-layer.ts`, `render.ts`). A layer with `scene` shows a sibling from `start`, trimmed to `[in, out)`, with trackable `x`, `y`, `scale`, `rotation`, `opacity`, `volume` and `mute`. At full opacity with no mask the shot draws straight onto the canvas with its own seeds, so it matches the shot alone pixel for pixel. Opacity and masks composite through offscreen surfaces that each host passes in (`src/embed/surfaces.ts`), since the engine never makes a canvas.
- **Masks** on any layer: a rig with params and tracks, cut in with `destination-in`.
- **The cast.** A layer with `"cast": "bruno"` draws the member's rig with its params, under the layer's own.
- **Project rigs** in `projects/<id>/rigs/`, offered only to that project's scenes. The runtime-budget test scans them too, and keeps each project's rigs to itself.
- **Sound through scene layers** (`src/audio/render.ts`). Each placed shot's sound renders once on its own, then its buffer is cut into the parent sample for sample, from `start`, through a gain that follows the layer's `volume` and `mute`. Cues can take `volume` keys, for a bed that ducks.
- **Exports.** MP4, GIF and HTML of any project scene. The embed carries every scene it places, the cast members they use and the project rigs they draw with. Outputs go to `out/<project>/<scene>/`.
- **The viewer.** The picker groups each project's scenes under its name, main first. A scene that places shots shows a band per shot under the scrubber; a click selects the scene layer and its span. Double-clicking a shot or a band, or **Open shot**, opens it at the matching frame, and a link goes back to the same moment.
- **Agents.** Project rigs are writable by default. An edit to `project.json`, through `update_project` or to the file, waits while another thread in the project works, for up to 50 s, then gives up with the reason. Each turn on a project scene saves `project.json` beside its checkpoint, marks the turn if `project.json` changed, and Revert to here restores both.
- **MCP.** `list_projects`, `get_project` and `update_project`. `update_project` also checks that every scene in the project stays valid. `list_scenes` shows each scene's project and each layer's rig, cast member or placed scene, and `list_rigs` marks project rigs. Every tool takes qualified ids.
- **The sample**, `projects/bears-story/`: `meet`, `pip` and `together` with bruno and pip from the cast, and `film`, which cuts at 3 s, crossfades from 6 s to 7 s and opens the project's `iris` rig onto `meet` again at 10 s, trimmed so meet's first blip stays out. A pad under the film ducks while `pip` plays.

### How each M9 acceptance criterion was verified

1. **The project in the viewer.** `tests/browser/viewer.test.ts` opens `?scene=bears-story/pip`, finds the project's scenes in an optgroup named "Bears' story" with `film (main)` first, and loose scenes outside it. Every earlier test still passes.
2. **Cut, crossfade, mask, and pixel identity.** `tests/projects.test.ts` finds the three transitions in `film` and checks that a shot showing in full draws the same paint calls as the shot alone. `tests/browser/projects.test.ts` compares real pixels: six film frames across the three shots hash the same as the matching shot frames. A contact sheet of the film showed the cut, a clean crossfade and the iris opening.
3. **The cast.** Both bears in every shot come from the cast. A changed cast colour reaches every shot that uses the member, and a layer's own param still wins. Through MCP, `update_project` on bruno's body changed the rendered shot.
4. **Project rigs.** `iris` is in `film`'s registry and not in a loose scene's, and a loose scene using it fails validation. The film's embed bundles it.
5. **Sound.** In the film's MP4, decoded by ffmpeg above the bed's range, pip's blip lands within a frame of the 3 s cut, and meet's second blip lands within a frame of 11 s. Meet's first blip, trimmed away, is silent at 10 s. Below 400 Hz, the bed's level while `pip` plays is under half its level before.
6. **Exports.** The film exports to MP4 (144 frames, 12 s, with audio), GIF and HTML. The HTML carries `meet`, `pip` and `together`, the `iris` rig and both cast members, makes no request but itself with the network off, and matches the render page's pixels at a plain frame, mid-crossfade and mid-iris. It comes to 70 KB.
7. **Threads in a project.** `tests/browser/agents.test.ts` runs the test agent on `meet` and `pip` at once, and `pip`'s thread finishes while `meet`'s works. A thread on `film` moves the cut from 3 s to 3.5 s. Its next turn changes bruno in the cast. The turn logs that it waits for meet's thread, and changes `project.json` only after that thread ends. Revert to here on that turn restores `project.json` and `film.json` together. `tests/node/queue.test.ts` covers the checkpoints and the revert rules.
8. **MCP.** `tests/browser/mcp.test.ts` works on a copy of the sample: `list_projects`, `get_project`, `update_project` (saved, invalid, would break a scene, and waiting for another agent's thread), qualified ids in `render_frame`, `hit_test`, `apply_to_selection`, `update_scene` and `export`, and `iris` marked with its project in `list_rigs`.
9. **Shot bands.** The film shows four bands, one per scene layer, with the crossfade's two in separate rows. A click selects `pip` over `[36, 84)`. A double-click on film frame 50 opens `pip` at frame 14, and the link back from frame 15 lands on film frame 51 with `pip` selected. Open shot on the trimmed `meet` from outside its span opens meet at frame 12.

The suites are at 1129 unit tests and 97 browser tests, all passing with the committed `bear-test.json`. Typecheck is clean.

### Deliberate deviations from ADR 0007 and the roadmap

- Cues gained `volume` keys. The ADR's audio section had volume only on scene layers, but the roadmap asks for a bed on the main scene that ducks, and the bed is a cue.
- A shot's sound renders in its own offline pass before its parent's, rather than all in one. Its buffer is then cut in exactly, which keeps the shot sounding as it does alone.
- A `project.json` edit waits for up to 50 s and then refuses, where the ADR said refused. The roadmap said it waits. The limit stays under Codex's 60 s tool timeout, and it stops two threads that both want the project from waiting on each other forever.

### M9 review

Two review agents read the M9 diff, one on the engine and tools and one on the viewer. These are fixed:

- **A moved shot showed what it draws off its stage.** With `x`, `y`, `scale` or `rotation` set, a shot's layers drew unclipped, so bruno walking in from x = -150 would show outside a pushed-in shot. A placed shot is now clipped to its own stage, and only when it's moved, so full-frame shots keep their exact pixels.
- **An edit to a shot didn't re-check the scenes that place it.** Shortening `meet` to 2.5 s saved, and broke `film`, whose trim runs to 3 s. `update_scene` and `apply_to_selection` now rebuild the project as the viewer would and refuse an edit that breaks any scene that works now. `update_project` uses the same check.
- **Double-clicking a band didn't open the shot at common widths.** The first click fills in the selection bar, which can wrap to a second line and push the bands up, so the second click missed. The bands now remember the one clicked, and a new test double-clicks one. The lanes also hang below the scrubber now, rather than padding it on both sides, which halves the jump when you open a shot.
- **Back used the span saved when the shot opened.** If the film's cut moved meanwhile, Back landed on the old frame. It now reads the span again, and a test moves the cut while the shot is open. If the parent can't render, it opens there once it can. The back link also goes away when its shot's file does.
- **Smaller ones:**
  - A loose scene id can't contain `/`, so it can never shadow a project scene.
  - The picker groups by project id, not name, so two projects with one name stay apart. `studio.scenes` is in picker order, as documented.
  - The back link is named "Back to bears-story/film", and bands say which layer they are when it differs from the shot, and whether they're selected.
  - A turn cancelled while it worked records a change to `project.json`, and reverts count it.
  - An external session working two threads in one project doesn't get a pass on the project rule.
  - The MCP render page reloads when `project.json` or any scene in the project changes, not only the scene's own file.
  - An `out` equal to a shot's duration keeps a partial last frame, as leaving `out` out does.
  - Error titles in the viewer use qualified ids.

After the fixes the suites are at 1132 unit tests and 99 browser tests, all passing with the committed `bear-test.json`.

### M10: Electron app

M10 is built as the ticket 19 grill settled it (ADR 0008), and its nine acceptance criteria pass. You asked for the build to go ahead on sensible defaults after the grill, with an overview to review; the defaults I picked are listed at the end of this section.

What M10 delivered:

- **A standalone studio server** (`tools/studio/server.ts`), replacing the Vite plugin. It serves the viewer, pairs callers, and pushes the queue, turn events, library changes and export progress over one event stream. It also serves:
  - the scene files, and rigs and generators through the module service
  - the render worker's jobs, exports, and the request queue
  - the agents in the studio and their MCP endpoint
- **Pairing.** Whoever starts the server gives it a token. The page trades the token for an HttpOnly cookie, through the app's preload or the `#token=` link `npm run dev` prints. Tools send it as a bearer token. The server writes `.frame-studio/server.json`, readable only by you, so tools on the folder reuse it.
- **The module service** (`tools/studio/modules.ts`). Node strips the types, and every import points to a URL carrying a hash of the file and everything it imports, so an edit reloads only that file and its importers. The Node side loads the same files through a resolve hook (`tools/studio/loader.ts`, `code.ts`). Runtime TypeScript is erasable: five constructors were rewritten, and typecheck enforces it. Rigs outside `src/` import the built-ins as `@frame-studio/...`.
- **Studio folders.** The tools, the server and the app work on one: `scenes/`, `projects/`, `rigs/`, `audio/`, `references/`, `out/`. The repo is one, with `src/` as its built-ins. A folder rig with a built-in's id is an error.
- **The render worker** (`render.html?worker`). It takes jobs over the event stream and posts results and bytes back. The app opens it in a hidden window. Any other server launches Electron in worker-only mode (`desktop/worker.ts`). The CLI, the MCP tools, exports and the pixel tests all render through it, so Electron's Chromium is the pixel reference. The CLI reuses a server already open on the folder, or starts a headless one.
- **Export in the viewer.** A panel for MP4, GIF or HTML of the scene or its range, with or without sound. It has progress and Cancel, writes into `out/`, and offers Reveal in Finder in the app.
- **The MCP shim.** `tools/mcp/server.ts` forwards every MCP message to the folder's studio server, or starts a headless one. External agents get their own session and the request queue's tools. The app ships the shim as `frame-studio-mcp`.
- **HTML exports on Rolldown alone.** Vite doesn't ship in the app.
- **The app** (`desktop/`):
  - welcome screen with New studio folder and Open folder; New makes `~/Frame Studio/` with `hello` and `bears-story`, and a `tsconfig.json` that maps `@frame-studio/` to the app's built-ins
  - reopens the last folder
  - File menu with Open Recent and Reveal Output Folder
  - the studio server in a utility process, restarted with backoff if it dies
  - the hidden render worker
  - PATH read from your login shell
  - single-instance lock, saved window bounds, sandboxed pages, navigation guards, logs in `~/Library/Logs/Frame Studio/`
- **Packaging** (`npm run desktop:build`, `tools/desktop/package.ts`).
  - electron-builder makes an unsigned macOS arm64 app and DMG.
  - Rolldown bundles the main process, the server and the shim into single files, so the only `node_modules` that ships is Rolldown's.
  - The engine, rigs, generators and embed player ship as source under `Resources/builtins/`.
  - A check (`tools/desktop/check.ts`) fails on any path named `claude-agent-sdk-` or an app over 300 MB.
- **`npm run dev`** runs the studio server on the repo with Vite's dev middleware inside, and prints the paired link. The token lasts across restarts. `npm run desktop` runs the app from the repo.

### How each M10 acceptance criterion was verified

1. **The build.** `npm run desktop:build` takes about 25 s. The app is 261.7 MB, under the 300 MB ceiling, and the DMG is 124 MB. `app.asar` holds seven files: the main bundle, the two preloads, the welcome page and `package.json`. Nothing named `claude-agent-sdk-` is anywhere in the app, and the check says so.
2. **Folders.** `tests/browser/desktop.test.ts` runs the app from source, and `tests/browser/packaged.test.ts` runs the built app. Both use a temporary settings folder and new folders in a temporary home.
   - New studio folder makes the folder with both samples and a `tsconfig.json`, and the viewer opens on it with no errors.
   - The next launch skips the welcome screen and reopens the folder.
   - The repo opens as a folder under `npm run dev`, and every other test uses it that way.
3. **Pairing.** A request without the cookie or token gets 401, and so does one with a wrong token. `server.json` has no group or other permissions. In the app, the page has only the three bridge functions, and no `require`.
4. **Loading code.** `tests/browser/studio-folder.test.ts` rewrites a folder rig's colour while the viewer is open. The canvas changes without a page reload, and the render worker's pixels change too. A folder rig that reuses `paper`'s id is refused. `tests/node/studio-server.test.ts` checks the service's URLs, rewriting, error modules and refusals. Every rig, including `iris`, now imports the built-ins by name.
5. **Agents from Finder.** Both app tests launch with launchd's short PATH. The server still finds `claude`, through the login shell. A test agent turn writes `rigs/twinkle.ts` into the folder, adds it to `hello` with `update_scene`, and the viewer shows the new layer.
6. **Export.** `viewer.test.ts` exports a GIF of frames `[0, 12)` from the panel. `packaged.test.ts` exports an MP4 range from the packaged app and finds Reveal in Finder. I didn't click Reveal, to keep Finder windows off your screen.
7. **The shim.** `mcp.test.ts` runs all its tools through `node tools/mcp/server.ts`, which starts a headless server. `packaged.test.ts` runs `frame-studio-mcp` with the app open, where it reuses the app's server, and again with the app closed, where it starts its own server and a worker from the app's files and renders and exports an HTML embed.
8. **Electron as the reference.**
   - `render.test.ts`: every frame of every scene hashes the same played or seeked; 2D canvas is on the CPU; and a second Electron launch draws identical pixels.
   - `embed.test.ts` and `projects.test.ts` open the HTML embeds in Electron and match the worker pixel for pixel, with the network off.
   - Timings: a CLI frame took 1.7 s through `npm run dev`'s server, an MP4 export of `audio-test` 0.8 s, and a contact sheet on a fresh folder 4.8 s including the headless start.
9. **Earlier tests.** Every earlier browser test now runs on the new paths. The suites are at 1143 unit tests and 112 browser tests, all passing with the committed `bear-test.json`, after the review fixes below. Typecheck is clean.

### M10 review

Two review agents read the M10 diff, one on the server and tools, one on the shell and the page. Between them they found 23 problems, the worst of them found by both. All of these are fixed:

- **A render job whose worker died never ended.** It also held up every later job, and with them every MCP tool, since tools run one at a time. The pool now sends an interrupted job to the next worker, starts a new Electron when the old one ended, and gives up on a job that takes down three workers. A page that stops responding (a rig looping forever) is crashed and reloaded. Cancel works with no worker connected, and before a job starts.
- **One rig that wouldn't strip blanked the viewer and killed the render worker.** The module list failed as a whole, the boot guard couldn't show why (the page policy blocked its inline script), and the worker never retried. Now each bad file gets a URL that serves its error, the viewer says what failed and tries again when files change, the worker keeps retrying its first load, and the boot guard is a file of its own.
- **`npm run dev` served the repo through Vite, the pairing token included**, at `/.frame-studio/dev-token`. Vite now gets only the pages, `src/` and its own paths, and denies `.frame-studio/` even through `/@fs/`. `server.json` is private from the moment it exists.
- **The app:**
  - Opening folders is one at a time now. A double click used to start two servers and leak one.
  - A folder that fails to open leaves you where you were, and says why.
  - A server that fails on restart is retried, and a restart never pulls you back to a folder you left.
  - Closing the viewer quits the app; the hidden worker window kept it running before. The Dock icon and a second launch bring the window back.
  - The login-shell PATH step really times out: interactive shells ignore SIGTERM, so it now uses SIGKILL.
  - Run from the repo, the app keeps its settings and logs under "Frame Studio", not "Electron".
  - The worker window stays on its page, opens nothing, and a pending reload can't hit a closed window.
- **Long MCP calls through the shim timed out at five minutes**, and were then sent again. Answers now stream with keep-alives, the shim retries only when the server was unreachable, and calls that arrive together share one connection.
- **Smaller ones:**
  - A missing Electron binary crashed the server; now the render job fails with the reason.
  - Edits to `src/rigs` went unnoticed on a server with a static viewer.
  - Files that import each other now hash as one, so an edit to one reloads all of them.
  - A malformed cookie from another local app broke every request.
  - The session cookie is named after the server's port.
  - The event stream sends the current state on connect, and the viewer says when the stream is gone for good.
  - Export's Cancel works before encoding starts and for HTML.
  - The Export panel keeps focus on one button through an export, announces progress, and closes with Escape.
  - The welcome buttons wait while a folder opens.
  - `FRAME_STUDIO_BUILTINS` reaches the shim.
  - Vite starts before the server takes requests.

### Defaults I picked for M10

These are yours to change. Most are a line or two.

- **Pushes use one Server-Sent Events stream**, not a WebSocket as ADR 0001 said. Every push is one-way, and it needs no library.
- **`npm run dev` hosts Vite inside the studio server**, rather than Vite proxying to it, so dev has one origin like the app. It listens on port 5173 as before, now on 127.0.0.1. The first visit needs the printed link.
- **Default port 4753** for the app's server, falling back to a free port when it's taken.
- **One render worker per server**, running one job at a time.
- **Built-in rigs load through the module service too**, not the viewer bundle, so there's one loading path. The first paint waits for them, a few hundred ms.
- **The app's CPU canvas switches apply to its viewer as well**, since Chromium switches are process-wide. Preview uses CPU raster in the app.
- **New studio folder uses `~/Frame Studio`**, or `~/Frame Studio 2` and so on when taken, without asking where.
- **No app icon yet**; it uses Electron's. (Since done: see below.)
- **An external agent's session** is named `mcp-<pid of its shim>`, so two Claude Code sessions on one app keep their claims apart.

### After M10: the icon, updates, and a redesign

You asked for three things after trying the app: an icon, updates like T3 Code's, and a UI pass after T3 Code and Mistral's Le Chat. The repo is public now, at https://github.com/emrosas/frame-studio.

- **The icon** (`tools/desktop/icon.ts`). It is drawn in code: four white viewfinder corners around an orange dot (#ff5a1f), on a black squircle.
  - The squircle is Apple's continuous corner on the macOS grid: an 824 px body inset 100 px, corner radius 185.4, smoothed 60%.
  - Each size in the `.icns` is drawn from the vectors, so 16 px stays crisp.
  - `desktop:build` puts the icon in the app and the DMG. `npm run desktop` sets it in the Dock.
  - The viewer and the welcome window use the same mark as an inline SVG (`Logo.svelte`), and the browser tab uses it as its favicon.
- **Updates (ADR 0009, `docs/RELEASING.md`).** The unsigned app updates itself in one click.
  - It reads electron-builder's `latest-mac.yml` from the latest GitHub release: 10 s after launch, every 4 hours, and from **Check for Updates…** in the app menu.
  - Update downloads the zip, checks its size and SHA-512 against the feed, and unpacks it beside the app. The app then quits, and a detached script swaps the bundle and relaunches it.
  - The viewer shows the offer in a card at the foot of the sidebar. The welcome window shows it too.
  - If the app can't replace itself (it runs from the DMG, from a translocated path, or from a folder you can't write to), the card links the release page instead.
  - `npm run desktop:release` checks the tag, origin/main and uncommitted shipped files. It then builds the DMG and zip, checks the zip, and writes the feed. `-- --publish` runs `gh release create`.
  - The feed format is electron-updater's, so once there's a Developer ID the signed app switches to electron-updater and the same releases keep working.
- **The redesign.** The viewer now has three columns:
  - **The sidebar:** the studio folder (click it to switch folders in the app), New thread, the scenes, each project's scenes (the main one marked), and the threads, with a status dot and a count of those waiting for you.
  - **The canvas:** a top bar with the scene, its format and frame rate, the shortcuts, Export and the panel toggles. Under the canvas, the timeline: transport, scrubber with the range and shot bands, and the selection as chips on one fixed line, so selecting never moves the canvas.
  - **The agent panel:** a new thread shows the three steps (click something, mark frames, describe) and ticks them as the selection fills in. An open thread reads like a chat, with your asks as bubbles and the agent's work under them, and follows new work while you're at the bottom. The composer is Le Chat's shape: what it's about, the prompt, then attach, agent, model, effort and Full access, with an orange send button.
  - **The rest:**
    - Both side columns collapse, and the layout is remembered.
    - Light and dark follow the system, on warm neutrals with one orange accent. Canvas selection stays blue so it reads on orange artwork.
    - Return sends a prompt; Shift+Return starts a new line.
    - The app's windows have no title bar: the window buttons sit over the sidebar, and the bars drag the window.
    - The welcome window has New and Open on the left and recent folders on the right.
  - **Where things moved:**
    - The scene picker became the sidebar's list.
    - The requests panel became the sidebar's threads plus the agent panel.
    - The frame rate readout moved into the top bar.
    - The keyboard hints moved into a shortcuts popover.
    - Export opens as a popover under its button.

How it was checked:

- Screenshots of the viewer and the welcome window in light and dark, at 1440 and 1024 wide, with a thread open, a shot selected, the Export popover open, and Claude picked in the composer.
- A screenshot of the app from source.
- The browser tests now find scenes in the sidebar, threads in the sidebar and the agent panel, and the frame rate in the top bar.
- `tests/node/updater.test.ts` covers the feed, versions, checksums, the preconditions and the swap script against plain folders.
- `tests/browser/packaged-update.test.ts` copies the built app into a temporary Applications folder and serves a 99.0.0 zip and feed locally. It checks that the offer arrives, that a wrong checksum is refused with the app untouched, and the menu's dialogs. Then it installs, checks the bundle on disk is 99.0.0 with nothing left over, and checks the relaunched app runs on its temporary settings.
- `desktop:release` ran end to end in a scratch copy whose origin was a local bare repo, including its three refusals.
- Not tried: a real GitHub release and its redirect, `--publish`, and replacing `/Applications/Frame Studio.app` itself.
- After the fixes: typecheck clean, 1165 unit tests and 116 browser tests pass (12 files, the two packaged suites on a fresh build), with the committed `bear-test.json`.

A review agent read the redesign and found 11 problems. All are fixed:

- A thread that ended while the agent panel was hidden got no notice. The toast now shows then too.
- A new thread's draft was lost when you opened a thread or hid the panel. The panel now holds the draft, and both side columns stay mounted when hidden.
- Try again reverted a turn with nothing on screen saying so. A note now says which turn Send reverts.
- The composer showed a different target than the reply would use. It now follows the App's rule: your selection on the thread's scene only when a layer or range is picked, and for Try again the reverted turn's selection.
- A thread stopped following new work once late-loading thumbnails grew it. It now follows content resizes while you're at the bottom.
- At narrow widths the frame readout spilled into the agent panel, and long layer names didn't shorten. The layer chip now shrinks, readouts drop out below set widths, and popovers fit the column.
- Light-theme contrast was too low:
  - Muted text is darker, at 5:1.
  - Buttons with words use a deeper orange (#d4410a) for white text at 4.6:1. The send button, dots and logo keep the brand orange.
  - Accent text is darker, and the focus ring is solid blue.
- Keyboard:
  - Export keeps focus when opened from the keyboard, so Tab reaches the popover.
  - Attach is a real button.
  - An invalid scene says so to screen readers.
  - The shortcuts popover is a region, not a dialog.
- Return no longer sends while Safari finishes Japanese or Chinese input.
- The project on screen can be folded.
- Dead icons, CSS, a prop and stale comments are gone.

### Before the first release: a README, a license, and an ad hoc signature

- `README.md` says what Frame Studio is, how to install the DMG and get past Gatekeeper, how updates work, the first steps, connecting an agent, and running from source. The project is MIT licensed (`LICENSE`).
- `desktop:build` signed nothing (`identity: null`). The only signature was Electron's own on the main binary, named `Electron` and covering none of the bundle, so `codesign --verify` failed. A downloaded copy would have been "damaged" to macOS, with Move to Trash as the only button.
- The build now signs ad hoc (`identity: '-'`), which signs the helpers and frameworks as `studio.frame.app.*` and seals all 167 files. `tools/desktop/check.ts` fails the build if the signature doesn't verify.
- Checked: the app and the release zip's copy verify, the two packaged suites pass (8 tests), and a copy flagged as downloaded by Safari opens to "Apple could not verify 'Frame Studio' is free of malware" with Done and Move to Trash, the prompt that Open Anyway clears.

### New scenes and projects from the sidebar

You found that the app had no way to start anything new: the sidebar only listed what was in the folder, and the MCP tools could only edit. Now:

- The + next to Scenes opens a New scene dialog: name, size (landscape 1920×1080, portrait 1080×1920, square 1080×1080), frame rate (12, 24 or 30) and length. The name becomes the id and the file, so "Opening shot" is `scenes/opening-shot.json`. The scene starts with paper and no layers.
- The + next to Projects makes `projects/<id>/project.json` (name, fps, size, `main`) and an empty main scene, `main`. New scene at the end of each project's scenes adds one with the project's fps and size.
- The viewer opens the new scene with a new thread. On a scene with no layers, the panel asks "What goes in this scene?" instead of listing the point-and-select steps.
- The studio server does the writing (`POST /__studio/scenes` and `/__studio/projects`) through the same workspace code as two new MCP tools, `create_scene` and `create_project`, and in turn with the other tools. Both refuse a taken or malformed id and a scene that wouldn't validate. The in-studio agents get the tools too, and creating doesn't ask, since it can't touch an existing scene.
- The rules for the input, and `toId`, which turns a typed name into an id, are in `src/studio/protocol.ts`, shared by the viewer and the server.
- Fixed on the way: a modal dialog now keeps the viewer's shortcuts off, so Escape closes the dialog rather than clearing the selection.

How it was checked: unit tests for the ids and input checks; MCP tests that create a loose scene, a project scene and a project, render them, and see each refusal; a browser test in a temporary studio folder that creates all three from the sidebar, checks the files and what the viewer opens, and checks that Escape closes the dialog. Screenshots of the dialog in light and dark, and of an empty scene with its new thread.

### M11: Type

You wanted real typography, for explainers and for still graphics such as social posts. ADR 0010 settles it: type is drawn from typefaces compiled to code.

- **Typefaces as code.** `npm run typeface` (`tools/type/`) reads a font with fontkit, a dev dependency, and writes a module of plain data: each glyph's advance and outline in font units, the vertical metrics, and pair kerning stored as classes, the way fonts store it. Classes cut the kerning from about 180 KB to 25 KB per face. It keeps ASCII, Latin-1, Latin Extended-A and common punctuation.
- **Seven built-ins,** all SIL OFL 1.1 with no Reserved Font Name: `inter`, `inter-bold`, `inter-display` (Black), `instrument-serif`, `instrument-serif-italic`, `fraunces` (Semibold, 72 pt) and `jetbrains-mono`. They come from each project's static builds (`tools/type/builtins.ts`). The first try used Google Fonts' variable files, whose overlapping contours showed as seams inside outlined letters. The static builds have them merged. `OFL.txt` sits beside the modules, and each module carries its copyright and license line.
- **Layout of our own** (`src/rigs/type/layout.ts`): advances, kerning, tracking, breaks at newlines, spaces and hyphens, a word wider than the line broken between letters, left, centre or right alignment on an anchor, and CSS-style line height. It never measures with the canvas.
- **The `text` rig:** text, font, size, anchor, align, valign (top, middle, baseline, bottom), width, lineHeight, tracking, case, fill, stroke, opacity, rotation, scale, and `reveal` for typing text on without moving it. Other rigs can use `drawText` and `layoutText`.
- **The embed** swaps the typeface index for one holding only the typefaces the scene names, plus `inter`, cut to the characters of the scene's strings in both cases. `type-test`, with all seven faces, exports at 232 KB; a scene with two words in Fraunces adds about 35 KB to a scene with no text. The full set is about 1.1 MB. A folder rig that imports `rigs/type/` itself turns the cut off.
- **A rule:** `tests/runtime-budget.test.ts` refuses `fillText`, `strokeText`, `measureText` and `ctx.font =` in any rig, built-in, folder or project.

How each acceptance criterion was verified:

1. `scenes/type-test.json` renders every face, kerned pairs, a tracked capital kicker, rotated outlined text, a paragraph wrapped at 560 px and centred, a line typed on, and the missing-glyph box. I looked at frames 18 and 47 through the render worker. `tests/browser/render.test.ts` checks it played against seeked, and the embed test checks frames 0, 6, 18, 30 and 47 against the render worker, byte for byte.
2. `src/rigs/type/layout.test.ts` covers advances and kerning, tracking, wrapping at a width with hanging spaces, hyphens and long words, alignment, line height and valign, the missing glyph, reveal and the outline flip, on a made-up typeface.
3. `src/rigs/type/faces/faces.test.ts` checks every built-in: every ASCII character, sane metrics, the license line, every outline traced to finite points, and well-formed kerning classes. The converter prints what each lacks: Instrument Serif lacks 47 symbols (±, µ, fractions…), and Fraunces the arrows.
4. The embed test caps `type-test` at 300 KB and checks each family's license line is in it and none is in `bear-test`'s. `tests/node/typeface.test.ts` checks the cut keeps kerning exact for the characters it keeps and comes to under a twentieth of the face.
5. The runtime-budget rule, with its own test.
6. `docs/SCENES.md` has the text rig, the typefaces, `drawText`, and how to add a typeface.

After it: typecheck clean, 1208 unit tests and 122 browser tests pass, with the committed `bear-test.json`.

### Question cards (ADR 0011)

You liked T3 Code's question UI and wanted the agents to use it, so choices take a click instead of a typed reply.

- When an agent asks, a card shows above the thread's actions: the question's header, the question, numbered options with the recommended first and a description each, and a line to type an answer of your own. A single-choice pick moves on and the last one sends. Multi-select questions take several picks plus a typed answer. Keys 1 to 9 pick, Enter moves on, Back goes back, Skip lets the agent decide. A preview, when an option has one, shows for the option with focus. The thread keeps each card with its answers.
- Claude's own `AskUserQuestion` and Codex's `request_user_input` both become this card through the turn's new `ask` callback. Before, the studio denied the first and answered the second with nothing. The runner waits on the card the way it waits on an approval, and Stop resolves it as skipped.
- Codex needs `features.default_mode_request_user_input`, which the adapter sets; the tool is experimental in Codex.
- The standing instructions tell agents to ask when a choice changes the result, and not otherwise.
- When a card or an approval opens in a thread that isn't showing, a toast says "#N needs you" with the question, and Answer opens the thread.
- The scripted test agent has an `ask` step.

How it was checked:

- Unit tests for the transcript fold and for `checkAnswers`.
- A browser test with the test agent: a two-question card answered with a pick, then two picks and a typed answer; a card answered by pressing 2; a skipped card; answers that don't fit refused with 400; Stop closing an open card, after which answering is refused with 409; and the toast and its Answer button when the thread isn't showing.
- Live, one turn each against the real CLIs with a stub answering "Blue": Claude (Haiku) asked through the card and replied "Blue"; Codex asked through the card and replied "Blue" once the prompt named request_user_input. The standing instructions name both tools.
- Screenshots in light and dark. They caught two bugs, both fixed: a preview shown on hover grew the card and moved the option away from the pointer, over and over; and the hover style hid a picked option's highlight. A third bug, the card resetting its picks whenever the thread view refreshed, was found by reading the code.

## Next

1. **Your own test of a complete creation**, with the MCP server in Claude Code:
   1. Approve `frame-studio` with `/mcp` in a session started in the repo.
   2. Run `npm run dev` and open the viewer.
   3. Select something, send a request, and run `/frame-studio:next` in Claude Code.
   4. Check the result with View, and export it yourself.

   Request #1 from the M6 demo is still in the queue, reverted. **Clear finished** archives it.
2. Try the sound: open `audio-test` in the viewer, click play, and export it with `npm run export -- --scene audio-test --target mp4` or `--target html`.
3. Try the integrated AI: in the viewer, select something, pick Claude or Codex in the agent panel's composer, and ask for a change.
4. Try a project: open `?scene=bears-story/film` in the viewer, double-click a shot, and export the film from the Export panel.
5. Try the app: `npm run desktop:build`, then open `build/desktop/dist/Frame-Studio-0.0.0-arm64.dmg`, or run it from the repo with `npm run desktop`. New studio folder makes `~/Frame Studio`. Register its MCP command with `claude mcp add frame-studio -- "/Applications/Frame Studio.app/Contents/Resources/bin/frame-studio-mcp"` from that folder.
6. **Try 0.2.0.** [v0.2.0](https://github.com/emrosas/frame-studio/releases/tag/v0.2.0) has New scene and New project (0.1.1) and type (M11). Update from Check for Updates…, make a scene, and ask the agent for a title or a post; then decide what the stills work needs.
7. **Next for type:** typefaces of your own in a studio folder, converted by the app from a font file you own (a `fonts/` folder, or a drop in the viewer), then the stills work from the feasibility talk: PNG and JPEG export, a Still option in New scene, and social size presets.
8. The roadmap has no M12 yet. Candidates from ADR 0008 and "Later": signing and notarization (then electron-updater), Windows and Linux builds, the timeline editor, selecting inside a shot from its parent, and threads that start without a scene, so the agent makes it from a description.

## Open questions

- The repo has two test-only fake contexts. `src/engine/testing/recording-context.ts` tracks full canvas state and serves the engine tests, `tests/scenes.test.ts` and the rig smoke tests. `src/rigs/testing/recording-context.ts` logs plain strings, throws on `ctx.canvas`, and serves the older rig tests. Should they merge? The engine one could take an option to throw on `ctx.canvas`.
- The HTML export builds with Vite and Rolldown in Node. Electron's main process is Node, so it can run the same build if it ships Vite, Rolldown's native binary and the rig sources. A browser tab can't run Vite, but the planned backend can, and Rolldown has a WebAssembly build. Which each shell uses is a packaging choice for the shell work (ADR 0001).
- Should the embed offer a sharper high-DPI mode? It would trade pixel parity with the PNGs for crispness on retina screens.
- Only a test enforces the rule that a scene file is named after its id. The viewer now opens a scene by file name too, and gives a shared id to the file named after it, but it does not flag a mismatch. Should the viewer or validator flag one? MCP `get_scene(id)` in M5 will need to map an id to a file.

## Known issues

- The sidebar shows a thread whose turn waits on a question card or an approval as Working. A toast says so when it happens, with Answer, but once dismissed only opening the thread shows it.
- Question cards work for agents the studio runs. An external agent over MCP asks in its own interface.

- URL writes are throttled to one per 400 ms. During playback, or just after switching scenes, `location.search` trails what is on screen until the next write. A reload still lands on the right frame, because `pagehide` stores the frame in sessionStorage and the reloaded page reads it. `pagehide` also flushes the URL, which covers Back and Forward. A copied URL can still be a few frames behind.
- Pausing freezes on the last frame drawn. That frame can be one behind the wall clock if the next animation frame had not fired yet, as in the 23 versus 24 frames seen after 2.0 s.
- `paper` paints black when `tone` is `none`. The validator accepts `none` for every colour param, but a background has no sensible "no paint".
- A rig that calls `save()` without a matching `restore()` leaks state on a real canvas, and `render` cannot detect it. The smoke tests catch this for the shipped rigs. New rigs need the same check, which they get by being added to `allRigs`.
- The selection outline traces every gap where the ground shows through a layer, such as the small triangle between `bruno`'s left ear and his head. It follows the pixels correctly but reads as a stray mark.
- A hover probe draws every layer in full, 5 to 11 ms on `bear-test`. Scenes with many layers or heavier rigs will feel it. A bounds cull would need rigs to declare bounds.
- The interface tests need Playwright's Chromium downloaded once (`npx playwright install chromium-headless-shell`); renders come from Electron, which `npm install` brings. This shell's environment sets `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain Node; the tools strip it, but run `electron` by hand with `env -u ELECTRON_RUN_AS_NODE`.
- `apply_to_selection` can add or merge overrides, but not remove one. In the user's first MCP test on 2026-09-24 ("remove the plaster"), the agent removed bruno's `bear.bandaged` override through `update_scene`, sending the whole `layers` array. Both the agent and I flagged this as clunky. A small "remove override" option on `apply_to_selection` would fix it.
- Opus plays 312 samples (6.5 ms) late in AVFoundation, which ignores the start delay Opus carries. It's the fallback only where there is no AAC encoder, such as Linux, and the error is well under a frame.
- Windows AAC exports assume AudioToolbox's 2112 priming samples. Media Foundation's count is unmeasured, so audio in MP4s exported on Windows may be off by a few milliseconds until someone measures it on a Windows machine.
- Mediabunny's reader ignores the trimmed audio edit list and reports an audio-bearing MP4 about 30 ms longer than it is. ffprobe and AVFoundation read it right. The tests read durations with ffprobe.
- A scene's sound renders in one piece, so a long scene with heavy generators takes a while before its sound plays in the viewer. The picture plays silent until then.
- Editing `src/rigs/parts/params.ts` now reloads the viewer instead of hot-swapping, because the audio renderer that the viewer imports reads params through it.
- Codex with full access applies edits without asking, so the check before editing a rig that another busy scene draws with applies to Claude only. The studio tools' scene rule still applies to both.
- The Claude Agent SDK package brings a 222 MB Claude Code binary into `node_modules`, which the studio never runs. It points the SDK at the installed `claude` instead. It is a dev dependency, so it stays out of the runtime and the embed.
- Codex's app-server protocol is marked experimental. The adapter is written against codex-cli 0.156, so check it on upgrades.
- A thread for an agent that isn't ready waits as pending until the agent is ready, with a note in the thread. Nothing times it out.
- With the default access, Codex runs commands it considers safe, such as `cat`, without asking, even on files outside the project. Claude asks before reading outside the project.
- Revert to here restores files without checking the rest of the project. If a turn adds a cast member and another thread's scene then uses it, reverting the first turn breaks that scene, and the viewer shows the error. Scene reverts have the same gap with scenes that place them.
- Hit testing stops at the scene layer: a click on a shot selects the whole shot. Selecting inside a shot from its parent is left for later (ADR 0007). Open the shot to select inside it.
- A hover probe on a scene that places shots draws each shot in full, so hovering a heavy film costs as much as rendering it.
- The busy-rig check for a thread on a main scene counts every rig its shots draw with, so an agent on another scene of the project gets asked before editing any of them.
- The app has no Developer ID. It is signed ad hoc, so a downloaded copy needs Open Anyway in System Settings › Privacy & Security the first time. Each build's ad hoc signature differs, so after an update macOS may ask again for access to protected folders such as Documents. Windows and Linux builds aren't made or tried.
- Updates have no Developer ID signature either: trust rests on HTTPS to GitHub and the feed's checksum. The app must sit in a folder you can write to, such as /Applications, and every update downloads the whole app, about 124 MB.
- Rig edits reload without a page reload, but the page and the server both keep old copies of the modules. A page with hundreds of edits behind it should be reloaded now and then (View, Reload in the app).
- The code host reloads every rig and generator after any change, in the server process. Hot code and a loop at import time would hang the server rather than a worker. The research suggested a worker thread for this, which isn't built.
- The render worker takes one job at a time, so a long export holds up the agents' renders until it ends.
- Node's type stripping still prints an experimental warning; the loader hides it. If Node changes the API, `tools/studio/loader.ts` and `modules.ts` are the places to look.
- Pixels match within Electron 44.4.5. Upgrading Electron may change them, and the pixel tests would say so.
- Under `npm run dev`, an edit to `src/engine` reaches the viewer and the render worker, but the server's own validation keeps the old engine until you restart `npm run dev`.
- The browser tests run their studio servers inside vitest, whose sandbox has no native `import()`. There the code host loads rigs through vitest's runner, which doesn't reload a rig's imports after an edit. The app and `npm run dev` use Node's loader, and the desktop tests cover that path.
- The access rules aren't a sandbox. Rig and generator code an agent writes runs in the studio server and the browser.

