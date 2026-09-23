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

- `src/engine`, `src/rigs`, and `src/audio` have **zero third-party runtime dependencies**. Validation libraries (zod or similar), Playwright, ffmpeg, and the MCP SDK are tooling only and must never be imported from the runtime path.
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
scenes/       Scene files (JSON). The primary thing the agent edits.
references/   Reference images supplied by the user (agent input only, gitignored).
tools/
  render/     Headless rendering via Playwright: frame -> PNG, range -> MP4/GIF.
  bundle/     Single-file HTML builder (tree-shakes unused rigs, inlines all).
  mcp/        MCP server exposing the studio to the agent.
out/          Renders and exports (gitignored).
```

Rules:
- `src/engine` never imports from `viewer`, `tools`, or UI code. It runs unchanged in the viewer, the headless renderer, the single-file embed, and any future desktop shell.
- The canvas renders at the scene's fixed resolution and is scaled with CSS for display. Handle devicePixelRatio for preview only; exports are always native resolution.
- UI is regular HTML/CSS positioned over the canvas, never drawn into it.
- The studio ships as a web app and as an Electron app from one viewer (`docs/adr/0001-web-and-electron-targets.md`). `src/viewer` uses web platform APIs only. Anything that needs the machine, such as scene files, export writing, video encoding or the MCP connection, goes behind an interface with a web implementation and an Electron one.
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

Engine support required from the start:
- `hitTest(probe, scene, frame, x, y, registry, options?)` returns the layer id (and, with `options.parts` where the rig declares parts, a part id) at that pixel. `probe` is a scratch 1x1 2D context.
- It uses **per-layer alpha probes**, not a flat-colour ID pass. Canvas 2D antialiases every path, so an edge pixel blends two ID colours into a colour that belongs to no layer. Instead, each layer is drawn alone, top first, into the probe with the pixel translated to (0, 0), and only its alpha is read. The layer with the largest share of the visible pixel wins. Parts work the same way inside the winning layer, cut at each `kit.part` boundary. The probe runs the same `drawLayer` code as the visible render, so the two can never drift. Research: `.scratch/frame-studio/research/id-pass-antialiasing.md`.
- Layer-level selection is required. Part-level is a nice-to-have.

## Reference images

Users can attach reference images to a prompt. References are **input to the agent only**: the agent looks at the image and writes drawing code from it. They are never embedded in a scene or any export, so outputs stay asset-free. Store them in `references/` and pass them to the agent by path.

## Audio

- Audio generators schedule Web Audio nodes for a time range, seeded like visuals.
- Preview plays live through an AudioContext synced to the viewer clock, including after seeking.
- Video export renders the same graph through an `OfflineAudioContext` to WAV, then muxes it via ffmpeg. Audio and video share the scene timeline as the single master clock.
- The HTML embed includes the audio generators unless exported silent. GIF is always silent.

## Headless rendering and export

- The viewer has a render mode (no UI, fixed size) exposing `window.studio.renderFrame(n)`.
- Playwright loads it, calls `renderFrame`, and captures the canvas as PNG.
- MP4 via ffmpeg (H.264) at scene fps. GIF via palette generation from the same frames.
- ffmpeg is an external dependency: check for it and fail with a clear message.
- A browser tab has no ffmpeg, so the encoder choice is open until ticket 14 (`.scratch/frame-studio/issues/14-export-encoding.md`) settles it. WebCodecs with a JS muxer is the main alternative.

## MCP server (the agent's API)

Keep inputs and outputs simple JSON. Tools:
- `list_scenes()`, `get_scene(id)`, `update_scene(id, patch)`: JSON merge patch, validated before saving
- `list_rigs()`: each rig's param schema, parts, and variants
- `render_frame(sceneId, frame | timecode)`: returns a PNG so the agent can see its work
- `render_contact_sheet(sceneId, from, to, every)`: a grid of frames for reviewing motion
- `hit_test(sceneId, frame, x, y)`: layer/part id at a pixel
- `apply_to_selection(selection, patch)`: writes a scoped override for the selection
- `export(sceneId, target)`: `mp4` | `gif` | `html`, returns an output path

## Conventions

- TypeScript, strict mode. Vite for the viewer. Vitest for tests.
- After changing drawing code, verify visually with `render_frame` or a contact sheet rather than assuming it looks right.
- Maintain `docs/PROGRESS.md`: done, next, open questions, known issues. Read it at the start of each session and update it at the end.
- The roadmap is `docs/ROADMAP.md`. Work milestone by milestone; don't start the next until the current one's acceptance criteria pass.

## Later (don't build yet)

- Desktop shell (Electron) wrapping the viewer. Chromium keeps canvas output identical between preview and export. The same viewer also ships as a web app (ADR 0001), so build nothing Electron-only into `src/viewer`.
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
