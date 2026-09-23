# Roadmap

Work in order. Each milestone ends when its acceptance criteria pass and `docs/PROGRESS.md` is updated.

## M1: Engine and viewer

Build the deterministic core and a viewer to watch it.

- Vite + TypeScript project with the folder structure in CLAUDE.md.
- Engine: timecode utils, easings, seeded RNG, track evaluation (numeric interpolation, stepped non-numeric), override evaluation, `render(ctx, scene, frame)`.
- Viewer: canvas at scene resolution scaled to fit, HTML overlay with play/pause, scrubber, frame step (←/→), timecode display (`MM:SS:FF`), fps readout, and a scene picker.
- A test scene: simple shapes moving with eased tracks at 12fps, one layer at `stepFps: 6` next to one at 12 so held frames are visible, a background layer, and one override range.

Acceptance:
- Scrubbing to any frame shows the same image as playing to it.
- Unit tests pass for timecode round-trip, quantization, easing endpoints, track evaluation, and override ranges (`[from, to)` boundaries).
- Playback holds real-time speed at the scene fps.
- The engine imports no third-party packages.

## M2: First character rig and hit testing

- Rig interface and registry with param schemas, declared parts, and variants.
- One character rig built from reusable parts (body, eyes with blink, limbs or wings) with a few poses, one expression param, and one variant used through an override.
- `hitTest` via per-layer alpha probes (the flat-colour ID pass cannot decode antialiased edges; see ticket 02).
- Viewer: clicking the canvas highlights the selected layer (outline or tint in the overlay, not on the canvas) and shows its id.

Acceptance:
- The character looks the same across the scene, including inside the variant's override range.
- Blinks and cycles are seeded and deterministic.
- Clicking the character, the background, and empty space each returns the correct layer on several frames, including mid-motion.

## M3: Headless render, MP4, and GIF

- Viewer render mode (no UI) exposing `window.studio.renderFrame(n)`.
- Playwright scripts: one frame to PNG; a range to MP4 and GIF.
- Determinism test: render frame N by seeking directly and after sequential playback from 0, then compare pixels.
- Contact sheet generator (a grid of every Nth frame in one PNG).

Acceptance:
- `npm run render -- --scene fly-test --frame 47` writes a PNG.
- `npm run export -- --scene fly-test --target mp4` and `--target gif` write files at 12fps with the correct duration.
- The determinism test passes.

## M4: Single-file HTML embed

- Bundler step that includes the engine, only the rigs the scene references (including variants), and the scene data, inlined into one `.html` file.
- The embed plays on load, loops by default, and exposes a tiny API (`play`, `pause`, `seek(frame)`) for host pages.
- `export(target: "html")` produces it.

Acceptance:
- The file works opened directly from disk with the network disabled.
- No external requests in the browser's network panel.
- Its frames match the headless PNG renders pixel for pixel.
- Report the file size; the engine portion stays under ~50 KB minified.

## M5: MCP server

- MCP server (TypeScript SDK) exposing the tools listed in CLAUDE.md, including `hit_test` and `apply_to_selection`.
- `render_frame` and `render_contact_sheet` return images.
- `update_scene` and `apply_to_selection` validate and reject bad patches with readable errors.
- Setup instructions for registering the server with a local coding agent.

Acceptance:
- From a fresh agent session: list scenes, render a frame, hit-test the character, apply a scoped change to it over a frame range, re-render, and see the change only inside that range.
- Export all three targets through MCP.

## M6: Selection-to-prompt in the viewer

- Viewer selection bar: pick a layer by clicking, set a frame range (from the scrubber or by typing timecodes), optionally attach reference images.
- Produce a selection payload (`{ sceneId, layerId, partId?, from, to }` plus prompt text and reference paths) that the user can hand to the agent, e.g. copy to clipboard or write to a file the MCP server can read.
- "Whole frame range" selection with no layer, for prompts like "redo frames 3 to 4".

Acceptance:
- Select the background for frames 1 to 14, prompt a change through the agent, and only those frames change.
- Select the character, attach a reference image, prompt a redraw, and the agent produces a rig variant applied through an override. The reference image appears in no scene file or export.

## M7: Procedural audio

- Audio generator interface with 2 to 3 examples (e.g. ambient pad, a buzz or footstep, a UI blip).
- Live preview synced to the viewer clock, including after seeking.
- Offline render to WAV, muxed into MP4. Generators included in the HTML embed.

Acceptance:
- Exported MP4 audio aligns to within one frame of scene timings.
- The same scene renders identical audio twice.
- The HTML embed plays audio after a user gesture (browser autoplay rules) and stays in sync after seeking.

## Later

- Desktop shell (Electron) around the viewer.
- Timeline editor for keys and timing; rig-controls panel generated from param schemas.
- Camera layer, scene transitions, multi-shot story files.
- Hosted service with prompt-crafting and style-steering UI.
