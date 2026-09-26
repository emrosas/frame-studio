# Frame Studio (working name)

An open-source tool for making storytelling and explainer animations drawn entirely in code. Every frame is rendered procedurally onto an HTML canvas by JavaScript. There are no image, video, or font assets, and sound is procedural too. A coding agent (via MCP, on the user's own machine) is a first-class operator: it can seek to any frame, see rendered frames, edit scenes and rigs, and export.

Inspiration: Kevin Ngo's pieces (kengoworks.com, @kevin_t_ngo): single HTML files with a canvas, computing each frame procedurally, with no embedded media.

## What this is, and what it is not

This is an **agent-authored** animation pipeline. In Rive and Lottie, a human draws artwork in a visual editor and a runtime plays it back. Here the artwork never exists as an asset: the agent writes drawing code, and that code is the artwork. The whole design serves that premise.

The intended edge over Rive, Lottie, and Remotion:
- **Open source**, for creators without access to paid vector tooling.
- **Three export targets from one scene**, including a single self-contained HTML file with no runtime library and no network requests. Lottie needs its player plus a JSON asset; Rive needs its runtime plus a `.riv` file; Remotion outputs video only.
- **The canvas is the selection surface** (see below): users point at what they see and prompt against it, instead of needing timeline and layer-panel fluency.

Do not add a dependency on Remotion, Rive, Lottie, GSAP, or any animation library. The runtime stays standalone.

## Export targets

One scene, three outputs:
1. **MP4**: frame-exact render at the scene fps, with audio.
2. **GIF**: the same frames, palette-quantized.
3. **Single-file HTML embed**: engine + only the rigs the scene uses + scene data (+ audio generators), inlined into one file. No external requests, no dependencies, droppable into any website.

The embed is the differentiator. Protect it with the runtime budget below.

## Core principle: determinism

The whole system rests on one rule: **the image at frame N is a pure function of (scene, frame, fps)**.

- Rendering is `render(ctx, scene, frame, registry)`. The registry is passed in so the engine never imports `src/rigs`. No state carried between frames.
- No `Math.random()` anywhere. Use the seeded RNG in `src/engine/rng.ts`, seeded from the scene seed plus a stable key (e.g. rig id).
- No `Date.now()` or `performance.now()` inside rendering, and no physics that integrates over time. If something needs simulation, compute it in closed form, or pre-simulate deterministically from frame 0 and cache it.
- Playing to frame N and seeking directly to frame N must produce identical pixels. A test enforces this.

## Runtime budget (protects the single-file embed)

- `src/engine`, `src/rigs`, `src/audio` and `src/embed` have **zero third-party runtime dependencies**. Validation libraries (zod or similar), Playwright, ffmpeg, and the MCP SDK are tooling only and must never be imported from the runtime path.
- Runtime TypeScript is **erasable**: no enums, namespaces or constructor parameter properties, since the studio server strips types with Node's own stripping instead of a bundler (ADR 0008). `npm run typecheck` enforces it. Rigs and generators outside `src/` (a studio folder's `rigs/` and `audio/`, a project's `rigs/`) import the built-ins as `@frame-studio/rigs/...`, `@frame-studio/engine/...` and `@frame-studio/audio/...`; inside `src/`, imports stay relative.
- The embed player (`src/embed/player.ts`) is the one runtime file allowed to read the wall clock, to pick the frame to show during playback. render() never sees time.
- No fonts, images, or base64 blobs. Text is drawn as vector paths in code or uses generic system font families.
- Target: engine under ~50 KB minified. Drawing code is expected to be the bulk of a file's size, and that's fine.

## Time model

- The scene declares `fps` (output frame rate, e.g. 12, 24, 30) and `duration` in seconds.
- Authoring is in **seconds**; the engine renders in **frames**. `frame = Math.floor(t * fps)`, `t = frame / fps`.
- Layers may declare their own `stepFps` (e.g. characters at 12 while the camera moves at 24). A layer quantizes its time with `tq = Math.floor(t * stepFps) / stepFps` before drawing, giving the held-frame "on twos" look.
- Timecode displays as `MM:SS:FF`, where `FF` is the frame within the second (0 to fps-1). Utilities in `src/engine/timecode.ts` must round-trip: `parse(format(f)) === f`.
- Frame ranges are `[from, to)` (inclusive start, exclusive end) everywhere: scene format, APIs, and UI.

## Architecture

```
src/
  engine/     Pure TS. No DOM except the CanvasRenderingContext2D passed in.
              render loop, timecode, easing, seeded rng, track and override
              evaluation, rig registry, hit testing, scene validation hooks.
  rigs/       Character/object rigs. Each rig = drawing function + param schema.
  audio/      Procedural audio (Web Audio). Same determinism rule as visuals.
  viewer/     Vite app: canvas + HTML overlay (scrubber, play/pause, timecode,
              fps) + selection layer. UI never draws on the canvas.
              render-main.ts is render mode (render.html) for the headless tools.
  export/     MP4, GIF and contact sheets, encoded in the page (WebCodecs +
              Mediabunny, gifenc). Browser code; never imported by the runtime.
  embed/      The player inside the single-file HTML embed: canvas, playback
              loop, window.studio and postMessage API. Runtime rules apply.
  studio/     The viewer-to-agent handoff protocol (ADR 0003): request and
              selection shapes and shared rules. Import-free, so Node uses it too.
desktop/      The Electron shell (ADR 0008): main process, preloads, welcome
              screen, and worker-only mode. Never imported by src/.
scenes/       Loose scene files (JSON). The primary thing the agent edits.
projects/     Projects (M9, ADR 0007): <id>/project.json (fps, size, main,
              cast), the project's scenes, and optional rigs/.
references/   Reference images supplied by the user (agent input only, gitignored).
tools/
  render/     CLI rendering through a studio server's render worker: frame -> PNG,
              range -> MP4/GIF, contact sheets. npm run render / export / contact-sheet.
  bundle/     Single-file HTML builder: validates the scene, bundles only the rigs
              it uses with the player, inlines all, with Rolldown.
              npm run export -- --target html.
  mcp/        The MCP tools (docs/MCP.md), and server.ts, the stdio shim an
              external agent starts, which forwards to a studio server.
  studio/     The studio server (ADR 0008): the viewer, pairing, the file
              store, the module service, the render worker's jobs, exports,
              the request queue on disk, and agents/, the agents it runs
              itself (M8). bin.ts runs it standalone; connect.ts finds or
              starts one for a folder.
  desktop/    npm run desktop and desktop:build: run and package the app.
  dev.ts      npm run dev: the studio server on the repo with Vite inside.
out/          Renders and exports (gitignored).
```

Rules:
- `src/engine` never imports from `viewer`, `tools`, or UI code. It runs unchanged in the viewer, the headless renderer, the single-file embed, and any future desktop shell.
- The canvas renders at the scene's fixed resolution and is scaled with CSS for display. Handle devicePixelRatio for preview only; exports are always native resolution.
- UI is regular HTML/CSS positioned over the canvas, never drawn into it.
- The studio ships as a web app and as an Electron app from one viewer (`docs/adr/0001-web-and-electron-targets.md`, ADR 0008). `src/viewer` uses web platform APIs only. Anything that needs the machine goes through the studio server, which serves the viewer, and the app's preload adds only native features (`src/viewer/desktop.ts`).
- The app and the tools work on a **studio folder** (ADR 0008): `scenes/`, `projects/`, `rigs/`, `audio/`, `references/`, `out/`, `.frame-studio/`. The built-in rigs and generators ship read-only inside the app; the repo is a studio folder whose built-ins are `src/`. A studio rig can't take a built-in's id.
- The viewer stays plain TypeScript until M6, then its UI moves to Svelte 5 with Vite, not SvelteKit (`docs/adr/0002-svelte-from-m6.md`). The runtime never imports Svelte.

## Scene format (JSON)

Scenes are data, so the agent, the selection UI, and any future timeline editor all edit the same thing.

```json
{
  "id": "fly-test",
  "fps": 12,
  "duration": 10,
  "size": [1920, 1080],
  "seed": 42,
  "background": { "rig": "paper", "params": { "tone": "#f4efe6" } },
  "layers": [
    {
      "id": "fly",
      "rig": "fly",
      "stepFps": 12,
      "params": { "x": 400, "y": 500, "scale": 1, "pose": "idle" },
      "tracks": [
        { "param": "x", "keys": [ { "t": 0, "v": 400 }, { "t": 3, "v": 1400, "ease": "inOutCubic" } ] },
        { "param": "pose", "keys": [ { "t": 0, "v": "idle" }, { "t": 3, "v": "fly" } ] }
      ],
      "overrides": [
        { "from": 36, "to": 48, "rig": "fly.wingTorn", "params": { "tilt": 0.2 } }
      ]
    }
  ],
  "audio": [
    { "id": "buzz", "generator": "buzz", "start": 3, "end": 6, "params": { "pitch": 220 } }
  ]
}
```

- Key times are in seconds. Numeric params interpolate with named easings; non-numeric params (strings, booleans) step.
- The background is a layer like any other (it can have tracks and overrides), so "change the background for frames 1 to 14" is an ordinary scoped edit.
- **`overrides`** express scoped edits: over a frame range, a layer may swap to a rig variant and/or apply param overrides. This keeps "change this element for frames 36 to 48" a contained change instead of forking drawing code. Overlapping overrides on one layer are invalid.
- **Projects (M9, ADR 0007).** A project is a folder, `projects/<id>/`, with scenes that share one fps and size. A scene can place another scene of its project as a **scene layer**: a start, a trim, and trackable placement and opacity. A shot renders identically inside its parent and on its own. Any layer can take an animated **mask**, which covers transitions. `project.json` holds a **cast**: named characters (rig plus params) that layers use with `"cast": "bruno"` and can override. Outside a project, its scenes have qualified ids, `<project>/<scene>`.
- Validate scenes on load and surface clear errors in the viewer.

## Rigs

A rig is `{ id, params: schema, parts?: string[], draw(ctx, params, t, rng, stage, kit) }`. `stage` is `{ width, height }` in scene pixels; rigs never read `ctx.canvas`. A rig that declares `parts` wraps every paint call in `kit.part(id, () => ...)`, so hit testing and selection masks can draw or read one part alone. `docs/SCENES.md` has the authoring guide for scenes and rigs, including the four rig rules that keep parts independent.
- `params` declares each parameter's type, default, and range. This schema drives the MCP `list_rigs` output and any future rig-controls UI, so keep it accurate.
- `t` is the layer's quantized local time, for internal cycles like wing flaps and blinks.
- Build rigs from small reusable parts (body, eye, limb) so characters stay consistent across shots. Consistency across shots is the hardest problem in this project: prefer shared parts over per-scene redrawing.
- Rig **variants** (e.g. `fly.wingTorn`) reuse their base rig's parts. They are how scoped edits stay visually consistent.

## The selection model and hit testing

The product direction: **the canvas is the selection surface**. Users don't manage a layer stack. They click what they see, pick a frame range, and prompt against that selection, similar to selecting elements in a browser view in a coding-agent app. Layers are addressable in code, and the UI surfaces them by pointing.

A **selection** is `{ sceneId, layerId, partId?, from, to }`. It's the unit passed to the agent alongside a prompt, and every edit tool accepts one. A selection with no `layerId` means "the whole frame range" (e.g. redo frames 3 to 4 entirely).

Selections reach the agent through files (`docs/adr/0003-selection-handoff-file-queue.md`). `.frame-studio/selection.json` holds the current selection. Each ask is a request file in `.frame-studio/requests/` that the agent claims through MCP tools and completes with a summary. The MCP server snapshots the scene when it claims a request, so the viewer can offer Revert and Try again. The files are the source of truth; the viewer and the MCP server keep nothing the other needs in memory. From M8 a request is a thread you reply to until you settle it, with a checkpoint per agent turn, worked by the external agent or the integrated AI (`docs/adr/0006-requests-are-threads.md`).

Engine support required from the start:
- `hitTest(probe, scene, frame, x, y, registry, options?)` returns the layer id (and, with `options.parts` where the rig declares parts, a part id) at that pixel. `probe` is a scratch 1x1 2D context.
- It uses **per-layer alpha probes**, not a flat-colour ID pass. Canvas 2D antialiases every path, so an edge pixel blends two ID colours into a colour that belongs to no layer. Instead, each layer is drawn alone, top first, into the probe with the pixel translated to (0, 0), and only its alpha is read. The layer with the largest share of the visible pixel wins. Parts work the same way inside the winning layer, cut at each `kit.part` boundary. The probe runs the same `drawLayer` code as the visible render, so the two can never drift. Research: `.scratch/frame-studio/research/id-pass-antialiasing.md`.
- Layer-level selection is required. Part-level is a nice-to-have.

## Reference images

Users can attach reference images to a prompt. References are **input to the agent only**: the agent looks at the image and writes drawing code from it. They are never embedded in a scene or any export, so outputs stay asset-free. Store them in `references/` and pass them to the agent by path.

## Audio

- Audio generators schedule Web Audio nodes for a time range, seeded like visuals (`src/audio`, ADR 0005). Authoring guide: `docs/SCENES.md`, "Writing a generator".
- Audio renders at 48 kHz, and a scene with audio needs an fps that divides 48000, so every frame starts on a whole sample. Cue times snap to frames.
- A cue's loudness can have keys (`tracks` on `volume`). A scene layer brings its shot's sound, rendered on its own and cut in sample for sample, shifted and trimmed, through the layer's `volume` and `mute` (ADR 0007).
- No input may receive more than two connections: Chromium sums three or more in an order that changes run to run. Sum with `mix()`.
- The whole scene's audio renders once through an `OfflineAudioContext`. The viewer preview, the embed and exports all play or encode that one buffer. Preview and embed keep it in step with the playback clock, including after seeking.
- Export encodes it with WebCodecs `AudioEncoder` (AAC-LC at 48 kHz, or Opus where there is no AAC encoder) and muxes it next to the video. AAC priming is signalled with an edit list and a `roll` sample group (`src/export/audio-track.ts`), or it plays 44 ms late. Audio and video share the scene timeline as the single master clock.
- The HTML embed includes the audio generators unless exported silent. It starts muted, since browsers allow sound only after a gesture. GIF is always silent.

## Headless rendering and export

- Renders for agents, the CLI and exports come from the **render worker** (ADR 0008): `render.html?worker` in a hidden Electron window (no UI, scene size, CPU raster), taking jobs from the studio server. The app opens it; a server without the app launches Electron in worker-only mode. Electron's Chromium is the pixel reference, so the pixel tests render through it too. Usage: `docs/SCENES.md`, "Rendering and exporting".
- Playwright drives the viewer's interface in the browser tests, and opens Electron windows where a test compares pixels.
- The page that draws the frames also encodes them. MP4 is H.264 through WebCodecs `VideoEncoder` at scene fps, muxed with Mediabunny. GIF is gifenc with our own palette code. The CLI, Electron and the web app run the same export code and differ only in where the bytes go (ticket 14, `.scratch/frame-studio/research/export-encoding.md`).
- MP4s are tagged BT.709 primaries, sRGB transfer and BT.709 matrix at full range, in both the SPS VUI and `colr`. WebCodecs only writes that for I420 frames that carry the colour space, so the exporter converts each frame itself (ticket 15, `src/export/color.ts`).
- No shipped build bundles ffmpeg. It is a dev-only tool for checking exported files: frame count, duration, frame rate, colour.

## MCP server (the agent's API)

`tools/mcp/server.ts`, over stdio, a shim that forwards to the studio server running on the folder, or starts a headless one (ADR 0008). The repo's `.mcp.json` registers it for Claude Code, and the app ships it as `frame-studio-mcp`. Setup and the full tool reference are in `docs/MCP.md`. Keep inputs and outputs simple JSON. Tools:
- `list_scenes()`, `get_scene(id)`, `update_scene(id, patch)`: JSON merge patch, validated before saving. Project scenes take qualified ids, `<project>/<scene>`
- `list_projects()`, `get_project(id)`, `update_project(id, patch)`: projects, and validated merge patches to `project.json`, which wait while another thread in the project works (ADR 0007)
- `list_rigs()`: each rig's param schema, parts, and variants, with `project` on a project's own rig
- `list_generators()`: each audio generator's param schema
- `render_frame(sceneId, frame | timecode)`: returns a PNG so the agent can see its work
- `render_contact_sheet(sceneId, from, to, every)`: a grid of frames for reviewing motion
- `hit_test(sceneId, frame, x, y)`: layer/part id at a pixel
- `apply_to_selection(selection, patch)`: writes a scoped override for the selection
- `export(sceneId, target, from?, to?, silent?)`: `mp4` | `gif` | `html`, returns an output path
- `next_request()`, `get_request(id)`, `complete_request(id, status, summary)`, `get_selection()`: the viewer's request threads and current selection (ADR 0003, ADR 0006). `complete_request` ends a turn; the user replies or settles. Plus the `/frame-studio:next` prompt and the `selection://current` resource

## Integrated AI (M8)

An AI inside the studio that works request threads like a chat in T3 Code (`docs/adr/0006-requests-are-threads.md`).
- It runs locally in the studio server. Providers launch the user's own signed-in CLI: `claude` through Anthropic's Agent SDK (dev-only package, pointed at the installed binary) and `codex app-server`. Never offer a login screen, never read or store the user's tokens, and never call it Claude Code. A missing or signed-out CLI shows the command to run.
- Its tools are the studio operations the MCP server offers. By default it may also write in `scenes/`, `rigs/`, `audio/`, projects' `rigs/`, and in the repo `src/rigs/` and `src/audio/`; anything else asks first through an approval card, unless the thread is in full access.
- One working thread per scene. Each agent turn gets a checkpoint, and only the user settles a thread.
- Only the studio server the viewer uses runs agents: the app's, or `npm run dev`'s. Headless servers (the CLI's, the MCP shim's, the tests') run with agents off, so a render or an MCP session never claims a thread. The server strips `ELECTRON_RUN_AS_NODE` from every agent CLI it starts, and the app reads PATH from the login shell so a Finder launch finds `claude` and `codex`. The scripted test agent appears with `FRAME_STUDIO_FAKE_AGENT=1`.

## Conventions

- TypeScript 6, strict mode. Vite for the viewer, with Svelte 5 for its UI (ADR 0002). Vitest for tests. `npm run typecheck` runs tsc for app and Node code and svelte-check for components. TypeScript 7 has no JavaScript API, which svelte-check needs, so the repo stays on 6.
- `npm test` is the unit suite. `npm run test:browser` runs Playwright against the viewer, the render worker, the embed, the handoff, the MCP shim, the app from source, and the packaged app when `npm run desktop:build` has built it.
- `npm run dev` runs the studio server on the repo and prints the viewer's paired URL. `npm run desktop` runs the app from the repo; `npm run desktop:build` packages it for macOS arm64 and checks the result.
- After changing drawing code, verify visually with `render_frame` or a contact sheet rather than assuming it looks right.
- Maintain `docs/PROGRESS.md`: done, next, open questions, known issues. Read it at the start of each session and update it at the end.
- The roadmap is `docs/ROADMAP.md`. Work milestone by milestone; don't start the next until the current one's acceptance criteria pass.

## Later (don't build yet)

- The app signed and notarized, auto-update, and Windows and Linux builds (ADR 0008 left them for later). The same viewer also ships as a web app (ADR 0001), so build nothing Electron-only into `src/viewer`.
- Timeline editor for keys and timing; rig-controls panel generated from param schemas.
- Camera layer (pan, zoom, shake), scene transitions, multi-shot story files.
- Hosted service: cloud rendering, prompt-crafting and style-steering UI, subscription instead of bring-your-own-key.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
