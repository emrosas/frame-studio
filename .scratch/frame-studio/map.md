# Frame Studio roadmap

Type: map

## Destination

Every milestone in `docs/ROADMAP.md`, M1 through M7, passes its acceptance criteria, and `docs/PROGRESS.md` records it.

## Notes

- The roadmap and `CLAUDE.md` already work as the spec, so this map carries execution. Milestone tickets are `task` tickets that build the milestone. The other tickets settle the decisions a milestone waits on.
- Work milestones in order. A milestone ticket resolves when its acceptance criteria pass, not when the code compiles.
- Write engine code test-first with `/tdd`. Run `/code-review` before closing a milestone ticket.
- Grilling tickets use `/grilling` and `/domain-modeling`. Prototype tickets use `/prototype`. Research tickets use `/research` and save findings under `research/` next to this map, with the answer gisted in the ticket.
- Look at rendered frames after any drawing change. Until M3 lands a headless renderer, open the viewer at `?scene=<id>&frame=<n>`.
- Dev machine toolchain, checked 2026-09-22. Node 26.8, npm 11.19, ffmpeg 7.1.1 at `/opt/homebrew/bin/ffmpeg`, and Playwright's headless Chromium already cached.
- The repo has no commits yet, so research lives in files next to this map instead of on `research/*` branches.

## Decisions so far

<!-- one line per resolved ticket: [title](issues/NN-slug.md), then the gist -->

- [M1: Engine and viewer](issues/01-m1-engine-and-viewer.md) M1 is done. `render` takes the registry, `draw` gets `stage`, tracks evaluate at quantized time, and override params beat tracks. Edit a scene file and the viewer swaps it in at the same frame.
- [How can the ID pass read exact layer colours when Canvas 2D antialiases every path?](issues/02-id-pass-antialiasing.md) Colour IDs can't be decoded at edges. Hit-test by drawing each layer, top first, into a 1x1 canvas at the click and keeping the layer with the most alpha. This departs from the "flat colour ID pass" in `CLAUDE.md`, so M2 should confirm it.
- [Can a headless render match the browser's canvas pixel for pixel?](issues/03-headless-pixel-fidelity.md) Yes, on CPU raster with a pinned Chromium on one machine. Launch with `--disable-accelerated-2d-canvas --disable-skia-runtime-opts` and capture with `canvas.toBlob`, not screenshots.
- [Is OfflineAudioContext output identical run to run?](issues/04-offline-audio-determinism.md) Yes on one machine, as long as no input gets three or more connections. Output differs across machines by less than -110 dB. Render at 48 kHz and start sources on whole samples.
- [How far can drawing code push a painted look?](issues/13-painted-look-prototype.md) Far enough. Gouache beat pastel and watercolour on likeness and cost (about 155 ms a frame), and became the `bear` rig and the `bears` scene.
- [What is the first character, and what does it need to do?](issues/05-first-character.md) The painted bear, with paws, four poses, four expressions, seeded blinks and a `bear.bandaged` variant. Every mark sits in a part with its own RNG fork.
- [M2: First character rig and hit testing](issues/06-m2-character-rig-and-hit-testing.md) M2 is done. The bear and `bear.bandaged` are the character, and `hitTest` uses per-layer alpha probes, now written into `CLAUDE.md`. The viewer selects a layer, a part, or a frame range, and hides the highlight during playback.

## Not yet specified

- How the MCP server renders frames. It could keep one warm Playwright browser or launch one per call. M3's render path shows which is cheap enough.
- One source of truth for scene validation. The engine needs a zero-dependency validator, and the MCP server has to validate JSON merge patches with readable errors. Whether MCP reuses the engine validator or wraps it stays open until M5.
- How an open viewer picks up edits the agent makes through MCP. Vite's file watcher may cover it, or the server may need to push.
- Text. The first scene that needs words will choose between vector paths in code and generic system fonts. System fonts render differently per machine, which may break the embed's pixel match.
- Where shared rig parts live. M2 produces one character. The second character will show which parts are actually shared.
- Frame-range picking moved into M2 at the user's request. M6 still owns the handoff to the agent.

## Out of scope

- The roadmap's "Later" list: an Electron shell, a timeline editor and rig-controls panel, a camera layer with transitions and multi-shot files, and a hosted service. The destination stops at M7.
