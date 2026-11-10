# Frame Studio (working name)

An open-source suite for making videos and images from code: storytelling and explainer animations, and still graphics. Every scene is drawn procedurally onto an HTML canvas by JavaScript, with no image, video or font assets. Sound is procedural, mixed with recorded sound files (voiceover, music) where a piece needs them (ADR 0012). Compositions can place recorded images and video as clips (ADR 0014); scenes never do. A coding agent (via MCP, on the user's own machine) is a first-class operator: it can seek to any frame, see rendered frames, edit scenes and rigs, and export.

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
3. **Single-file HTML embed**: engine + only the rigs the scene uses + scene data (+ audio generators), inlined into one file. No external requests, no dependencies, droppable into any website. Sound files stay out unless the export is asked to inline them (ADR 0012).

Stills (PNG, JPG) are planned (M16).

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
- No fonts, images, or base64 blobs in rigs or scenes. Picture clips in compositions come from `media/` and are decoded by the hosts, never by `src/engine` or `src/embed`; an HTML export refuses them (ADR 0014). The one blob exception: an HTML export asked to carry a scene's sound files inlines them (ADR 0012); by default it leaves them out. Text is drawn as vector paths from typeface modules: the `text` rig, or `drawText` in `src/rigs/type/layout.ts` (ADR 0010). `npm run typeface` turns an open-licensed font into such a module. Rigs never call `fillText`, `strokeText` or `measureText`, or set `ctx.font`; a test enforces it.
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
scenes/       Scene files (JSON): what draws. The primary thing the agent edits.
compositions/ Compositions (M14, ADR 0013): tracks of clips that place scenes
              and other compositions. The repo has none yet.
projects/     Films made before compositions (M9, ADR 0007): <id>/project.json,
              the film's scenes, and optional rigs/. Convertible into project
              folders (tools/studio/convert.ts).
references/   Reference images supplied by the user (agent input only, gitignored).
tools/
  render/     CLI rendering through a studio server's render worker: frame -> PNG,
              range -> MP4/GIF, contact sheets. npm run render / export / contact-sheet.
  bundle/     Single-file HTML builder: validates the scene, bundles only the rigs
              it uses with the player, and only the glyphs its text uses, and
              inlines all, with Rolldown. npm run export -- --target html.
  bench/      npm run bench:export: MP4 export speed by stage through the render
              worker, serial against parallel (ADR 0019).
  type/       npm run typeface: font file -> typeface module (fontkit, dev only),
              the built-in typefaces' sources, and the embed's glyph cut.
  voice/      Generate Voice (ADR 0017): providers/, one file each, loaded by
              the app's main process, and Kokoro, which the server runs.
  mcp/        The MCP tools (docs/MCP.md), and server.ts, the stdio shim an
              external agent starts, which forwards to a studio server.
  studio/     The studio server (ADR 0008): the viewer, pairing, the file
              store, the module service, the render workers' jobs, exports
              (long MP4s split across workers and muxed here, ADR 0019),
              the request queue on disk, and agents/, the agents it runs
              itself (M8). bin.ts runs it standalone; connect.ts finds or
              starts one for a folder.
  voice/      Word timing (ADR 0016): whisper-cli, its model, script alignment,
              and npm run voice:setup.
  desktop/    npm run desktop and desktop:build: run and package the app.
  dev.ts      npm run dev: the studio server on the repo with Vite inside.
out/          Renders and exports (gitignored).
```

Rules:
- `src/engine` never imports from `viewer`, `tools`, or UI code. It runs unchanged in the viewer, the headless renderer, the single-file embed, and any future desktop shell.
- The canvas renders at the scene's fixed resolution and is scaled with CSS for display. Handle devicePixelRatio for preview only; exports are always native resolution.
- UI is regular HTML/CSS positioned over the canvas, never drawn into it.
- The studio ships as a web app and as an Electron app from one viewer (`docs/adr/0001-web-and-electron-targets.md`, ADR 0008). `src/viewer` uses web platform APIs only. Anything that needs the machine goes through the studio server, which serves the viewer, and the app's preload adds only native features (`src/viewer/desktop.ts`).
- **A project is a folder** (ADR 0013), the studio folder the app and the tools work on (ADR 0008): `project.json` (name, default format, cast), `scenes/`, `compositions/`, `projects/` (old films, until converted), `rigs/`, `audio/`, `media/` (sound files, ADR 0012), `references/`, `out/`, `.frame-studio/`. The app lists each recent project in the sidebar, read from disk, and shows one on screen; a project's row opens its library, and Threads lists every project's threads in one list. A project's server runs while it's on screen, while a thread there works, and for ten minutes after you leave it (the last two left). The Done fold, layout and recent models live in the app's settings, since each server has its own port. The built-in rigs and generators ship read-only inside the app; the repo is a studio folder whose built-ins are `src/`. A studio rig can't take a built-in's id.
- The viewer stays plain TypeScript until M6, then its UI moves to Svelte 5 with Vite, not SvelteKit (`docs/adr/0002-svelte-from-m6.md`). The runtime never imports Svelte.

## Scene format (JSON)

Scenes are data, so the agent, the selection UI, and the timeline all edit the same thing.

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
- **Compositions (M14, ADR 0013).** Scenes draw and never place anything. A composition, `compositions/<id>.json`, arranges: `{ id, fps, duration, size, background?: colour, tracks: [{ id, clips }], audio? }`, bottom track first. A clip places a scene or another composition with a start, a trim (`in`, `out`), trackable placement, opacity and volume, and an optional animated **mask**, which covers transitions. Compositions nest up to 16 deep, loops are refused, clips run at their composition's fps, and a clip of another size sits centred. A clip renders identically inside its composition and on its own. The engine renders a composition as a scene whose layers are its clips (`src/engine/composition.ts`). Scenes and compositions share one id namespace.
- **Pixel stages (ADR 0014).** `pixel: { scale, palette?, dither? }`: rigs draw on `size / scale`, and `render()` snaps to the palette with ordered dither and blows up square pixels. Coordinates are the small stage's. Use the `pixel-text`, `sprite`, `sky`, `ridge`, `drift` and `arrow` rigs.
- **The camera (ADR 0014).** `camera: { x, y, zoom, tracks }`, with `depth` on layers: 0 stays put, 1 is the world, between is further away.
- **Markers (ADR 0014).** `markers: [{ t, label }]` on scenes and compositions. A label ending in `!` is a sync point the check tool tests.
- **Words (ADR 0016).** A file cue owns `words: [{ id, text, start, end, p? }]` in seconds into the file, with `script?` and `lang?`. A key or marker takes `word: "voice#w12"` beside its `t`; `anchorWords` overwrites `t` from it in the library, which every host loads through. An orphan keeps its last `t`, and the check tool reports it. `media/<file>.words.json` is Whisper's cache; nothing renders from it.
- **The cast.** `project.json` holds named characters (rig plus params) that layers use with `"cast": "bruno"` and can override.
- **Old films (M9, ADR 0007)** in `projects/<id>/` still work: scenes sharing one fps and size that place each other as scene layers, with qualified ids, `<project>/<scene>`. The viewer converts one into a project folder of its own on request.
- Validate scenes on load and surface clear errors in the viewer.

## Rigs

A rig is `{ id, params: schema, parts?: string[], draw(ctx, params, t, rng, stage, kit) }`. `stage` is `{ width, height }` in scene pixels; rigs never read `ctx.canvas`. A rig that declares `parts` wraps every paint call in `kit.part(id, () => ...)`, so hit testing and selection masks can draw or read one part alone. `kit.speech(cueId)` gives a rig a cue's words in scene time (ADR 0016). `docs/SCENES.md` has the authoring guide for scenes and rigs, including the four rig rules that keep parts independent.
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

## Hand edits (ADR 0015)

The timeline edits a scene's key times, and a press on the canvas drags a layer. On a composition it also adds, splits, duplicates, deletes and moves clips between tracks, and sound moves, trims, fades, splits and duplicates on scenes and compositions alike (ADR 0018, `src/studio/timeline-edit.ts`). Hand edits change when and where; values, drawing and easing stay the agent's, but for the transition presets, which write plain keys. A drag shows through a patched copy of the scene in the viewer, and `render()` never hears about it. A canvas drag writes params when untracked, a key at the playhead when tracked, and an override when a range is set around the playhead (`src/viewer/drag.ts`). Everything saves through the server's checked edit, stays locked while an agent works on the scene, and shares one Command-Z stack, which the Edit menu reaches too. A spoken word's text and timing are hand-editable too (ADR 0016), and dragging a key anchored to a word detaches it.

## Reference images

Users can attach reference images to a prompt. References are **input to the agent only**: the agent looks at the image and writes drawing code from it. They are never embedded in a scene or any export, so outputs stay asset-free. Store them in `references/` and pass them to the agent by path.

## Audio

- Audio generators schedule Web Audio nodes for a time range, seeded like visuals (`src/audio`, ADR 0005). Authoring guide: `docs/SCENES.md`, "Writing a generator".
- A cue can play a sound file from the studio folder's `media/` instead (ADR 0012): `{ id, file, start, end, in?, fadeIn?, fadeOut?, tracks? }`. The hosts decode the files and hand them to the renderer, which copies their samples into the scene's one buffer.
- Audio renders at 48 kHz, and a scene with audio needs an fps that divides 48000, so every frame starts on a whole sample. Cue times snap to frames.
- A cue's loudness can have keys (`tracks` on `volume`). A scene layer brings its shot's sound, rendered on its own and cut in sample for sample, shifted and trimmed, through the layer's `volume` and `mute` (ADR 0007).
- No input may receive more than two connections: Chromium sums three or more in an order that changes run to run. Sum with `mix()`.
- The whole scene's audio renders once through an `OfflineAudioContext`. The viewer preview, the embed and exports all play or encode that one buffer. Preview and embed keep it in step with the playback clock, including after seeking.
- Export encodes it with WebCodecs `AudioEncoder` (AAC-LC at 48 kHz, or Opus where there is no AAC encoder) and muxes it next to the video. AAC priming is signalled with an edit list and a `roll` sample group (`src/export/audio-track.ts`), or it plays 44 ms late. Audio and video share the scene timeline as the single master clock.
- The HTML embed includes the audio generators unless exported silent. It starts muted, since browsers allow sound only after a gesture. GIF is always silent.

## Generate Voice and keys (ADR 0017)

Rigs run in the viewer page and the server, so a provider key reaches neither. `desktop/keys.ts`, main process only, keeps safeStorage ciphertext in `keys.json`; a window of main's own takes the key. Generating goes bridge, sender check, native dialog, pinned host (`tools/voice/pinned.ts`), then `media/` under a name main picks. No server route, status codes only in logs. Providers are files in `tools/voice/providers/`, added by pull request, never loaded from a project. Kokoro needs no key: sherpa-onnx-node 1.13.8 and the model download on first use to `~/.frame-studio/models/`, sha256-pinned, and nothing GPL ships in the app. The browser and `npm run dev` have Kokoro only.

Before a folder's `rigs/` or `audio/` load the first time, main asks. Trust is stored by real path and code hash, and the server rechecks the approved hash (`--code-hash`) right before first reading the code. An untrusted server (`--untrusted`) runs built-ins only, with agents off. What counts as code, and what code may import, is one list in `tools/studio/project-code.ts`, used by the hash, the Node loader and the module service: imports leaving `rigs/`, `audio/` or that film's `rigs/`, other than built-ins, are refused, as are packages and links that leave. A server the app didn't start loads built-ins only, unless given `--trust` or `FRAME_STUDIO_TRUST=1`; the repo counts as trusted.

## Headless rendering and export

- Renders for agents, the CLI and exports come from the **render worker** (ADR 0008): `render.html?worker` in a hidden Electron window (no UI, scene size, CPU raster), taking jobs from the studio server. The app opens it; a server without the app launches Electron in worker-only mode. Electron's Chromium is the pixel reference, so the pixel tests render through it too. Usage: `docs/SCENES.md`, "Rendering and exporting".
- Playwright drives the viewer's interface in the browser tests, and opens Electron windows where a test compares pixels.
- The page that draws the frames also encodes them. MP4 is H.264 through WebCodecs `VideoEncoder` at scene fps, muxed with Mediabunny. GIF is gifenc with our own palette code. The CLI, Electron and the web app run the same export code and differ only in where the bytes go (ticket 14, `.scratch/frame-studio/research/export-encoding.md`).
- An MP4 of 10 s or more splits across render workers (ADR 0019): helper windows on more slots, each with its own session, encode segments that start on key frames, one renders the sound, and the studio server muxes them with the page's muxer (`src/export/mp4-mux.ts`). The encoder restarts at every key frame on both paths, so the worker count never changes the frames. `npm run bench:export` measures it.
- MP4s are tagged BT.709 primaries, sRGB transfer and BT.709 matrix at full range, in both the SPS VUI and `colr`. WebCodecs only writes that for I420 frames that carry the colour space, so the exporter converts each frame itself (ticket 15, `src/export/color.ts`).
- No shipped build bundles ffmpeg. It is a dev-only tool for checking exported files: frame count, duration, frame rate, colour.
- The timing job (ADR 0016, `tools/voice/`) runs `whisper-cli` at a pinned version, built by `npm run voice:setup` for the repo and by `tools/desktop/package.ts` for the app. Its model downloads on first use to `~/.frame-studio/models/`, and the render worker decodes the sound for it.

## MCP server (the agent's API)

`tools/mcp/server.ts`, over stdio, a shim that forwards to the studio server running on the folder, or starts a headless one (ADR 0008). The repo's `.mcp.json` registers it for Claude Code, and the app ships it as `frame-studio-mcp`. Setup and the full tool reference are in `docs/MCP.md`. Keep inputs and outputs simple JSON. Tools:
- `list_scenes()`, `get_scene(id)`, `update_scene(id, patch)`: scenes and compositions, and JSON merge patches validated before saving, along with every composition that places the file. Old films' scenes take qualified ids, `<project>/<scene>`
- `get_project(id?)`, `update_project(id?, patch)`: the folder's `project.json` with no id, an old film's with one (which waits while another thread in the film works); `list_projects()`: the old films
- `create_scene(id, fps?, size?, duration)`, `create_composition(id, fps?, size?, duration)`: an empty scene (paper, no layers) and an empty composition (one track), in `project.json`'s format by default. The viewer's sidebar makes the same through the studio server
- `list_rigs()`: each rig's param schema, parts, and variants, with `project` on a project's own rig
- `list_generators()`: each audio generator's param schema
- `list_media()`, `import_media(path)`: the sound files in `media/` with their lengths, and copying one in (ADR 0012)
- `align_voice(sceneId, cueId, script?)`: times a sound cue's words and writes them into the cue; with a script, words and punctuation come from it (ADR 0016)
- `generate_voice(text, lang, voice?)`: Kokoro speaks into `media/`, with no key (ADR 0017)
- `render_frame(sceneId, frame | timecode)`: returns a PNG so the agent can see its work
- `render_contact_sheet(sceneId, from, to, every)`: a grid of frames for reviewing motion
- `hit_test(sceneId, frame, x, y)`: layer/part id at a pixel
- `apply_to_selection(selection, patch)`: writes a scoped override for the selection, or with `{ remove: true }` clears the overrides in it
- `check(sceneId, from?, to?)`: measures a scene or composition before anyone watches it (format, black, freeze, flashing, loudness, sync; ADR 0014)
- `export(sceneId, target, from?, to?, silent?, media?)`: `mp4` | `gif` | `html`, returns an output path; `media` inlines sound files in HTML
- `next_request()`, `get_request(id)`, `complete_request(id, status, summary)`, `get_selection()`: the viewer's request threads and current selection (ADR 0003, ADR 0006). `complete_request` ends a turn; the user replies or settles. Plus the `/frame-studio:next` prompt and the `selection://current` resource

## Integrated AI (M8)

An AI inside the studio that works request threads like a chat in T3 Code (`docs/adr/0006-requests-are-threads.md`).
- It runs locally in the studio server. Providers launch the user's own signed-in CLI: `claude` through Anthropic's Agent SDK (dev-only package, pointed at the installed binary) and `codex app-server`. Never offer a login screen, never read or store a CLI's tokens, and never call it Claude Code. Pasted provider keys are separate: encrypted by the app, in the main process only (ADR 0017). A missing or signed-out CLI shows the command to run.
- Its tools are the studio operations the MCP server offers. By default it may also write in `scenes/`, `compositions/`, `rigs/`, `audio/`, `project.json`, old films' `rigs/`, and in the repo `src/rigs/` and `src/audio/`; anything else asks first through an approval card, unless the thread is in full access.
- One working thread per scene. Each agent turn gets a checkpoint, and only the user settles a thread.
- The runner only works turns this server took through its own routes in this session (ADR 0017). A pending turn found on disk waits in its thread for a click on Start, at studio access unless the click says otherwise. Stored access never carries to a turn the user didn't send.
- An agent asks the user to choose through a question card (ADR 0011): Claude's `AskUserQuestion` and Codex's `request_user_input` both become the same card, and the turn waits for the answers, as it does for an approval.
- Only the studio server the viewer uses runs agents: the app's, or `npm run dev`'s. Headless servers (the CLI's, the MCP shim's, the tests') run with agents off, so a render or an MCP session never claims a thread. The server strips `ELECTRON_RUN_AS_NODE` from every agent CLI it starts, and the app reads PATH from the login shell so a Finder launch finds `claude` and `codex`. The scripted test agent appears with `FRAME_STUDIO_FAKE_AGENT=1`.

## Conventions

- TypeScript 6, strict mode. Vite for the viewer, with Svelte 5 for its UI (ADR 0002). Vitest for tests. `npm run typecheck` runs tsc for app and Node code and svelte-check for components. TypeScript 7 has no JavaScript API, which svelte-check needs, so the repo stays on 6.
- `npm test` is the unit suite. `npm run test:browser` runs Playwright against the viewer, the render worker, the embed, the handoff, the MCP shim, the app from source, and the packaged app when `npm run desktop:build` has built it.
- Tests that launch the app set `FRAME_STUDIO_BACKGROUND=1` (`desktop/background.ts`), so its windows never take focus or show over the person's work. Check viewer UI in Playwright's headless Chromium, not in a shown window.
- `npm run voice:setup` builds the pinned whisper-cli. Without it the timing tests skip.
- `npm run dev` runs the studio server on the repo and prints the viewer's paired URL. `npm run desktop` runs the app from the repo; `npm run desktop:build` packages it for macOS arm64 and checks the result. `npm run desktop:release` builds a release for the app's updater (ADR 0009, `docs/RELEASING.md`).
- After changing drawing code, verify visually with `render_frame` or a contact sheet rather than assuming it looks right.
- Maintain `docs/PROGRESS.md`: done, next, open questions, known issues. Read it at the start of each session and update it at the end.
- The roadmap is `docs/ROADMAP.md`. Work milestone by milestone; don't start the next until the current one's acceptance criteria pass.

## Later (don't build yet)

- Generate Video. Providers allow the kind and a poll seam (ADR 0017); nothing else exists.
- The app signed and notarized, with electron-updater in place of the unsigned updater (ADR 0009), and Windows and Linux builds (ADR 0008 left them for later). The same viewer also ships as a web app (ADR 0001), so build nothing Electron-only into `src/viewer`.
- A rig-controls panel generated from param schemas.
- Multi-shot story files.
- Hosted service: cloud rendering, prompt-crafting and style-steering UI, subscription instead of bring-your-own-key.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
