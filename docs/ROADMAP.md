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
- Playwright scripts: one frame to PNG; a range to MP4 and GIF. The encoder follows ticket 14, and the export path must also run in Electron and a browser tab (ADR 0001).
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

- First, move the viewer's UI to Svelte 5 (ADR 0002). Plain TypeScript modules stay plain, and components wrap them.
- The studio server protocol (ADR 0001): HTTP endpoints plus a WebSocket for pushed changes, served by a Vite dev-server plugin, with the types in one shared module.
- The handoff from ADR 0003:
  - The viewer keeps `.frame-studio/selection.json` current.
  - A request panel takes prompt text and reference images, copied into `references/`.
  - "Send to agent" writes `.frame-studio/requests/NNNN.json` and copies a one-line summary to paste into any agent.
- MCP additions: `next_request`, `get_request`, `complete_request`, `get_selection`, the `/frame-studio:next` prompt, and the `selection://current` resource. Claims are atomic.
- A queue panel: status (pending, in progress, stalled, done, failed), the agent's summary, cancel and requeue, and clicking a request to restore its selection. A notice with **View** appears when a request finishes.
- Checkpoints: a scene snapshot when a request is claimed, with **Revert** and **Try again** on the newest request for each scene.
- "Whole frame range" selection with no layer, for prompts like "redo frames 3 to 4".

Acceptance:
- Select the background for frames 1 to 14, prompt a change through the agent, and only those frames change.
- Select the character, attach a reference image, prompt a redraw, and the agent produces a rig variant applied through an override. The reference image appears in no scene file or export.
- Revert on a finished request restores the scene exactly as it was. Try again queues the same ask as attempt 2.

## M7: Procedural audio

- Audio generator interface with 2 to 3 examples (e.g. ambient pad, a buzz or footstep, a UI blip).
- Live preview synced to the viewer clock, including after seeking.
- Offline render through `OfflineAudioContext`, encoded with WebCodecs `AudioEncoder` and muxed into MP4 (ticket 14). Generators included in the HTML embed.

Acceptance:
- Exported MP4 audio aligns to within one frame of scene timings.
- The same scene renders identical audio twice.
- The HTML embed plays audio after a user gesture (browser autoplay rules) and stays in sync after seeking.

## M8: Integrated AI

An AI inside the studio that works on your selections like a chat in T3 Code (ADR 0004, ADR 0006).

- Requests become threads: pending, working, your turn, settled. There's a checkpoint per turn with "Revert to here", and only you settle a thread.
- A provider layer with two adapters that launch the user's own signed-in CLI:
  - Claude, through the Agent SDK pointed at the user's installed `claude`
  - Codex, through `codex app-server`

  The studio has no login screen and handles no tokens. Both adapters get the studio's operations as tools.
- Per-thread agent, model, effort and access mode. By default the agent uses the studio tools and writes in `scenes/`, `src/rigs/` and `src/audio/`. Anything else shows an approval card, and full access is a switch.
- One working thread per scene. Threads on different scenes run in parallel.
- A left panel with the thread list. A thread opens in place, with streamed text, one line per step, frame thumbnails, approval cards, and a reply box showing the selection it applies to.
- Stop, interrupted turns with Retry, and sessions that resume. Transcripts live in `.frame-studio/`.
- The external agent works threads through the same MCP tools.
- A scripted fake provider for the automated tests.

Acceptance:
1. Select a layer and a range, pick Claude, and send. The thread streams text, one line per step, and the frames the agent rendered. The edit lands only inside the range. A reply such as "a bit smaller" continues the same session. "Revert to here" on the first turn restores the scene exactly. Settle closes the thread.
2. The same loop works with Codex.
3. With the default access, the agent writes a new rig variant in `src/rigs/` without asking. Editing a file anywhere else, or running a shell command, shows an approval card, and declining blocks it. Full access removes the prompts.
4. Two threads on different scenes work at the same time. A second thread on the same scene waits until the first thread's turn ends.
5. Stop keeps the edits so far and hands the thread back. Restarting the dev server mid-turn shows Interrupted with Retry, and the next reply resumes the provider's session.
6. A thread sent to "External agent" is taken by `/frame-studio:next`. Your reply puts it back in the queue with the full history, and `complete_request` ends the turn.
7. A missing or signed-out CLI shows as unavailable in the agent picker, with the command to run. Nothing in the studio asks for credentials.

## M9: Projects

Many scenes in one project, stitched into one longer video (ADR 0007).

- `projects/<id>/` folders with `project.json` (name, fps, size, main, cast), scenes, and optional project rigs. `scenes/` stays as loose scenes.
- Qualified scene ids (`<project>/<scene>`) in URLs, threads, the queue and MCP.
- Scene layers: a scene placing another scene of its project, with a start, a trim, and trackable position, scale, rotation and opacity. There are no cycles, and nesting has a depth limit.
- Masks on any layer, animated like any rig, for iris and wipe transitions.
- A cast of named characters that layers use and can override.
- Audio through scene layers, shifted and trimmed, with trackable volume and mute. The main scene can add cues across cuts.
- The viewer:
  - a project and scene picker
  - shot bands on the scrubber
  - Open shot at the matching frame, and back
- Agents: project rigs are writable by default. A `project.json` edit waits until no other thread in the project is working. Turns also checkpoint `project.json`.
- MCP: `list_projects`, `get_project` and `update_project`, and qualified ids in every tool.

Acceptance:
1. A project in `projects/<id>/` shows in the viewer with qualified ids in the URL. Loose scenes and every existing test are unchanged.
2. The sample `projects/bears-story/` main scene places at least three shots, with a cut, a crossfade and a mask transition. Where a shot shows in full, the main scene's frame is pixel-identical to the shot rendered alone at the matching frame.
3. The shots use `bruno` and `pip` from the cast. A cast change changes every shot, and a layer's own param still wins.
4. A rig in `projects/bears-story/rigs/` is offered only to that project's scenes, and bundles into its embed.
5. Shots' audio comes along, shifted and trimmed. A music bed on the main scene ducks under a shot. In the MP4, blips at the cuts land within one frame.
6. The main scene exports to MP4, GIF and HTML. The HTML carries the nested shots, the project rigs and the cast, and makes no requests.
7. Threads on two shots work at once, and a thread on the main scene edits the cut. A cast edit waits while a shot's thread works. Revert to here on a turn that changed the cast restores both files.
8. `list_projects`, `get_project` and `update_project` work, every tool takes qualified ids, and `list_rigs` marks project rigs.
9. Shot bands show on the main scene's scrubber. Double-clicking a shot opens it at the matching frame, and the link returns.

## M10: Electron app

The desktop shell from ADR 0001, on studio folders and one studio server (ADR 0008).

- A standalone studio server: the built viewer, pairing, the request queue and agents, a file store and a module service for rigs and generators, an event stream, and the MCP endpoint. `npm run dev` runs it on the repo with Vite in front for the viewer's own code.
- A render worker page that takes jobs from the server, in a hidden Electron window. The CLI and the pixel tests render through it.
- An Export button in the viewer.
- The `frame-studio-mcp` shim for external agents.
- Main and preload scripts that carry only native features. The installed app leaves out the Claude Agent SDK's bundled Claude binary.

Acceptance:
1. `npm run desktop:build` makes `Frame Studio.app` and a DMG for macOS arm64. A check after the build fails if the app is over 300 MB or holds anything named `claude-agent-sdk-`, and it passes.
2. Opened from Finder, the app offers New studio folder and Open folder. New creates `~/Frame Studio/` with `hello` and `bears-story`, which open and play. The repo opens as a studio folder too, and the app reopens the last folder on the next launch.
3. The studio server refuses every request without the pairing cookie or token. The page reaches native features only through the desktop bridge.
4. Rigs and generators load through the module service in the app and in `npm run dev`. An edit to a rig in the studio folder shows in the viewer without a reload, and a render worker renders it the same. Runtime TypeScript is erasable, and typecheck says so. Project rigs import the built-ins as `@frame-studio/...`.
5. An agent in the app, launched from Finder, finds `claude` and `codex`, and a test agent turn writes a rig into the studio folder's `rigs/` and uses it.
6. The viewer exports MP4, GIF and HTML of the scene or the range, with or without sound, with progress and Cancel, into `out/`. The app reveals the file in Finder.
7. The `frame-studio-mcp` shim works every MCP tool through a running app, and through a headless server when no app is open.
8. `npm run render`, `export` and `contact-sheet` and the pixel tests render in Electron through the render worker, and the HTML embed matches the worker's pixels.
9. Every earlier test passes on the new paths.

## M11: Type

Typography drawn entirely from code (ADR 0010), for explainers and still graphics.

- `npm run typeface` turns a font file into a typeface module: glyph outlines, advances, kerning and metrics as plain data.
- Built-in typefaces from open-licensed fonts, with their licenses.
- A layout module of our own: kerning, tracking, wrapping, alignment and line height, the same on every machine.
- A `text` rig that draws it, with `reveal` for typing text on.
- The HTML embed carries only the typefaces and glyphs a scene uses.

Acceptance:
1. `scenes/type-test.json` shows every built-in typeface, wrapped and aligned text, tracking and a typed-on line. Its frames draw the same pixels played or seeked, and in the embed as in the render worker.
2. Unit tests cover the layout: kerning, tracking, wrapping at a width, explicit newlines, alignment, line height and the missing-glyph fallback.
3. Every built-in typeface has every ASCII character, outlines that trace to finite points, well-formed kerning and sane metrics. The converter reports what each lacks of its set.
4. The embed of a scene with a few words is a small fraction of the typefaces' full size.
5. No rig calls `measureText`, `fillText` or sets `ctx.font` to draw scene text.
6. `docs/SCENES.md` documents the `text` rig, the typefaces and how to add one.

## Later

- Retiming shots (speed, freeze, reverse), selecting inside a shot from its parent, and a library of transitions (ADR 0007, out of scope for M9).
- Timeline editor for keys and timing; rig-controls panel generated from param schemas.
- Camera layer and scene transitions.
- Hosted service with prompt-crafting and style-steering UI.
