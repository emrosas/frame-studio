# 0007: Projects are folders, and scenes place scenes

Status: accepted, 2026-09-25 (ticket 17)

## Context

A scene is one continuous stretch of time on one stage, and so far every scene stands alone in `scenes/`. The user wants longer videos made of many scenes, with the parts editable at the same time without disturbing each other. M8 already allows one working thread per scene, so separate scenes are how parallel work stays safe. The user also wants mask-based transitions. `CLAUDE.md` names consistency across shots as the project's hardest problem. Electron (ADR 0001) needs a file-backed scene store, which depends on how scenes sit on disk.

## Decision

- **A project is a folder**, `projects/<id>/`. It holds `project.json` (name, `fps`, `size`, `main`, `cast`), its scenes, and optionally `rigs/`. `scenes/` stays as it is: loose scenes with bare ids, like a project without a `project.json`.
- **Ids.** Inside a project, a scene refers to a sibling by its bare id. Everywhere else (URLs, threads, the queue, MCP) a project scene has a qualified id, `<project>/<scene>`.
- **Scenes place scenes.** A scene layer places another scene of the same project. It has a `start` in the parent, a trim `[in, out)` in the shot's own seconds, and trackable position, scale, rotation and opacity. A cut is two scene layers back to back, and a crossfade is two overlapping ones with opacity keys. There are no cycles, nesting has a small depth limit, and there is no retiming yet.
- **A shot looks the same everywhere.** A shot renders pixel-identically inside a parent and on its own. Its layers keep their own seeds, the shot's seed plus the layer id.
- **Masks.** Any layer can take a `mask`: a rig with params and tracks, and the layer shows only where the mask draws. Irises, wipes and shape reveals are masks with animated params.
- **The main scene** is named by `project.json` and is an ordinary scene: it can add its own layers, masks and audio cues around the shots. Exporting it exports the whole video. Any other scene, such as a trailer, exports on its own too.
- **One fps and size per project.** Every scene in a project uses the project's `fps` and `size`, and the validator checks it.
- **A cast.** `project.json` names characters, each a rig with params. A layer uses `"cast": "bruno"` and can still override params, so one edit to the cast changes every shot.
- **Rigs.** The global `src/rigs/` library stays. A project can add its own rigs in `projects/<id>/rigs/`, offered only to that project's scenes.
- **Audio.** A scene layer brings its shot's cues, shifted by `start` and cut to the trim, with a trackable `volume` and a `mute`. The main scene can add cues across cuts. It all renders in one offline pass (ADR 0005).
  - Added while building M9: a cue can take `volume` keys too, so a music bed on the main scene can duck under a shot. A shot's sound renders once, on its own, and its buffer is cut into the parent's sample for sample, so it sounds exactly as it does alone.
- **Export.** The main scene exports to MP4, GIF and one HTML embed. The embed carries the nested shots, the project rigs and the cast.
- **The viewer.**
  - The picker lists projects, then their scenes, with loose scenes apart.
  - On a scene that places shots, the scrubber shows each shot's span, and a click selects the scene layer.
  - Double-clicking a shot, or **Open shot**, opens it at the matching frame, with a link back. Selecting inside a shot from its parent comes later.
- **Agents and threads** (ADR 0006).
  - Threads name scenes by qualified id.
  - Default access adds `projects/<id>/rigs/` to the folders an agent writes freely.
  - An edit to `project.json` counts as touching every scene in the project: it goes ahead only when no other thread in the project is working, and is refused otherwise.
  - A turn in a project checkpoints `project.json` as well as its scene, so "Revert to here" restores both. Rig code stays with git.
- **MCP.**
  - Every tool takes qualified ids.
  - `list_scenes` groups scenes by project, and `list_rigs` marks project rigs.
  - New tools: `list_projects`, `get_project`, and `update_project`, a validated merge patch under the project-edit rule.
- **Order.** Projects become M9, and Electron moves to M10, so its scene store reads a finished layout.

## Consequences

- The engine gains three things: scene layers (a scene drawing another scene at a mapped frame), masks (compositing through an offscreen layer), and cast resolution. Scene layers are the one place the engine renders a scene inside a scene. Hit testing stops at the scene layer for now.
- Validation grows project-wide: `fps` and `size` match, scene layers point at existing siblings without cycles, and cast entries name real rigs with valid params.
- The embed can grow large for a long project. That's expected: it carries the whole video as code.
- Out of scope for now: retiming, selecting inside a shot from its parent, several named outputs per project, shots with their own fps or size, a library of ready-made transitions, and sharing rigs or casts between projects beyond `src/rigs/`.
