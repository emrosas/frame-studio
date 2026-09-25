# Frame Studio roadmap

Type: map

## Destination

Every milestone in `docs/ROADMAP.md`, M1 through M9, passes its acceptance criteria, and `docs/PROGRESS.md` records it.

## Notes

- The roadmap and `CLAUDE.md` already work as the spec, so this map carries execution. Milestone tickets are `task` tickets that build the milestone. The other tickets settle the decisions a milestone waits on.
- Work milestones in order. A milestone ticket resolves when its acceptance criteria pass, not when the code compiles.
- Write engine code test-first with `/tdd`. Run `/code-review` before closing a milestone ticket.
- Grilling tickets use `/grilling` and `/domain-modeling`. Prototype tickets use `/prototype`. Research tickets use `/research` and save findings under `research/` next to this map, with the answer gisted in the ticket.
- Look at rendered frames after any drawing change. Until M3 lands a headless renderer, open the viewer at `?scene=<id>&frame=<n>`.
- Dev machine toolchain, checked 2026-09-22. Node 26.8, npm 11.19, ffmpeg 7.1.1 at `/opt/homebrew/bin/ffmpeg`, and Playwright's headless Chromium already cached.
- Research lives in files next to this map, not on `research/*` branches. The repo's first commit, on `main`, came after M2.
- The studio ships as a web app and as an Electron app (`docs/adr/0001-web-and-electron-targets.md`). The viewer moves to Svelte at the start of M6 (`docs/adr/0002-svelte-from-m6.md`).

## Decisions so far

<!-- one line per resolved ticket: [title](issues/NN-slug.md), then the gist -->

- [M1: Engine and viewer](issues/01-m1-engine-and-viewer.md) M1 is done. `render` takes the registry, `draw` gets `stage`, tracks evaluate at quantized time, and override params beat tracks. Edit a scene file and the viewer swaps it in at the same frame.
- [How can the ID pass read exact layer colours when Canvas 2D antialiases every path?](issues/02-id-pass-antialiasing.md) Colour IDs can't be decoded at edges. Hit-test by drawing each layer, top first, into a 1x1 canvas at the click and keeping the layer with the most alpha. This departs from the "flat colour ID pass" in `CLAUDE.md`, so M2 should confirm it.
- [Can a headless render match the browser's canvas pixel for pixel?](issues/03-headless-pixel-fidelity.md) Yes, on CPU raster with a pinned Chromium on one machine. Launch with `--disable-accelerated-2d-canvas --disable-skia-runtime-opts` and capture with `canvas.toBlob`, not screenshots.
- [Is OfflineAudioContext output identical run to run?](issues/04-offline-audio-determinism.md) Yes on one machine, as long as no input gets three or more connections. Output differs across machines by less than -110 dB. Render at 48 kHz and start sources on whole samples.
- [How far can drawing code push a painted look?](issues/13-painted-look-prototype.md) Far enough. Gouache beat pastel and watercolour on likeness and cost (about 155 ms a frame), and became the `bear` rig and the `bears` scene.
- [What is the first character, and what does it need to do?](issues/05-first-character.md) The painted bear, with paws, four poses, four expressions, seeded blinks and a `bear.bandaged` variant. Every mark sits in a part with its own RNG fork.
- [M2: First character rig and hit testing](issues/06-m2-character-rig-and-hit-testing.md) M2 is done. The bear and `bear.bandaged` are the character, and `hitTest` uses per-layer alpha probes, now written into `CLAUDE.md`. The viewer selects a layer, a part, or a frame range, and hides the highlight during playback.
- [How should exports encode MP4 and GIF in the web app, in Electron and from the CLI?](issues/14-export-encoding.md) One path for all three: the render page encodes H.264 with WebCodecs and muxes with Mediabunny, and only where the bytes go differs. GIF uses gifenc with our own palette code. Audio is AAC with signalled priming, falling back to Opus. No shipped build bundles ffmpeg. The CLI needs Playwright 1.57 or later, and ticket 15 follows up on colour tags.
- [Which colour tags make an exported MP4 decode to the scene's exact colours everywhere?](issues/15-mp4-colour-tags.md) BT.709 primaries, the sRGB transfer and the BT.709 matrix at full range, in both the VUI and `colr`. WebCodecs only writes them for I420 frames that carry the colour space, so exports convert frames themselves.
- [M3: Headless render, MP4, and GIF](issues/07-m3-headless-render-mp4-gif.md) M3 is done. `npm run render`, `export` and `contact-sheet` drive `render.html` in Playwright 1.63. Exports encode in the page, and `npm run test:browser` checks determinism, frame counts, durations and colours.
- [M4: Single-file HTML embed](issues/08-m4-single-file-html-embed.md) M4 is done. `--target html` bundles the player, the scene's own rigs and the scene into one file with no requests, about 54 KB for `bear-test`. It matches the headless renders byte for byte, ships no validator, and takes `window.studio` or `postMessage` commands.
- [M5: MCP server](issues/09-m5-mcp-server.md) M5 is done. `node tools/mcp/server.ts` serves the nine tools over stdio, and `.mcp.json` registers it for Claude Code. One watching Vite server feeds Node and a lazily started Playwright page, and tools run one at a time. Edits validate before saving and split overlapping overrides.
- [How does a selection reach the agent?](issues/10-selection-handoff.md) Through files in `.frame-studio/`: a current selection, and a queue of request files the agent claims atomically through MCP tools, plus a Claude Code slash command and resource. Scene checkpoints on claim allow Revert and Try again. The viewer uses one studio server protocol, T3 Code-style (ADR 0003, ADR 0001 amended), and an integrated AI becomes M8 (ADR 0004).
- [M6: Selection-to-prompt in the viewer](issues/11-m6-selection-to-prompt.md) M6 is done. The viewer UI is Svelte (TypeScript 6 for svelte-check). The request queue, studio server, MCP request tools and Requests panel work end to end, with checkpoints, Revert and Try again. The studio server takes same-origin JSON only.
- [M7: Procedural audio](issues/12-m7-procedural-audio.md) M7 is done. Generators build Web Audio graphs for cues. The whole scene renders once offline, and the viewer, the embed and exports all play or encode that buffer (ADR 0005). MP4 audio is AAC with its priming signalled by an edit list and a patched-in `roll` group, or Opus. The embed starts muted and plays after a click.
- [What does the integrated AI need to do?](issues/16-m8-integrated-ai.md) Requests become threads like a T3 Code chat: pending, working, your turn, settled. Each turn has a checkpoint and only you settle. It runs locally in the studio server with two providers that launch the user's own signed-in CLI, Claude through the Agent SDK and Codex through `codex app-server`, with no login screen. By default it has studio tools and writes in `scenes/`, `src/rigs/` and `src/audio/`, with approvals for anything else. One working thread per scene, and a left thread panel (ADR 0006). Electron becomes M9, after a Projects grill (ticket 17).
- [M8: Integrated AI](issues/18-m8-integrated-ai-build.md) M8 is done. Requests are threads with per-turn checkpoints and Settle. The studio runs Claude (the Agent SDK with in-process studio tools) and Codex (`codex app-server`) through the user's own signed-in CLIs, streaming each turn into a left panel with approval cards. One working thread per scene holds across processes, and the studio server answers only this computer.

## Not yet specified

- Text. The first scene that needs words will choose between vector paths in code and generic system fonts. System fonts render differently per machine, which may break the embed's pixel match.
- Where shared rig parts live. M2 produces one character. The second character will show which parts are actually shared.
- Frame-range picking moved into M2 at the user's request. M6 still owns the handoff to the agent.
- Where the Electron build keeps scenes. Local files come first (ADR 0001), but `import.meta.glob` and hot reload only work in dev. The web app's backend comes after the local path works.
- How the web app reaches an agent. It can't reach a local MCP agent or a local CLI. Its route is a tool loop over the Anthropic and OpenAI APIs with the user's keys, run by its backend (ADR 0006), or the hosted service.

## Out of scope

- The roadmap's "Later" list: an Electron shell, a timeline editor and rig-controls panel, a camera layer with transitions and multi-shot files, and a hosted service. The destination stops at M9, the Electron app, which the user scheduled on 2026-09-25 after M8 and the Projects grill.
