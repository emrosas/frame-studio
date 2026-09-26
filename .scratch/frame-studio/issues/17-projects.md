# Projects: many scenes, one longer video

Type: grilling
Status: resolved
Blocked by: 18

## Question

The user's idea, raised on 2026-09-25 while settling ticket 16, and still loose: a **project** holds several **scenes**, and they are stitched together, perhaps in a scene of their own, into one longer video. Parts of it can then be edited at the same time without compromising any of them. M8 allows one working thread per scene, so separate scenes are how parallel work stays safe, and projects would carry that to a whole video.

It overlaps the roadmap's "multi-shot story files" and "scene transitions" in Later. Settle before M9, because it decides how scenes sit on disk, which Electron's file-backed scene store depends on:

- what a project is on disk, and how scenes and shared rigs belong to it
- how scenes are stitched: a sequence file, or a scene that places other scenes as layers with time offsets
- transitions between scenes, and whether audio runs across cuts
- exporting a project: one MP4, GIF or embed from many scenes
- how the viewer, the thread list and the MCP tools address a scene inside a project
- what "consistent across shots" means for characters shared between scenes

## Answer

Settled with the user on 2026-09-25 and recorded in `docs/adr/0007-projects-and-scene-layers.md`. Ticket 20 builds it as M9, and Electron moves to M10 (ticket 19).

- **A project is a folder**, `projects/<id>/`, with `project.json` (name, fps, size, main, cast), its scenes, and optional `rigs/`. `scenes/` stays as loose scenes.
- **Ids:** qualified ids (`<project>/<scene>`) outside a project, and bare ids inside.
- **Stitching.** Scenes place scenes as **scene layers**, with a start, a trim, and trackable placement and opacity. Any layer can take an animated **mask**, which covers iris and wipe transitions. The main scene is an ordinary scene that places the shots. A shot renders identically inside and alone.
- **One fps and size per project.** A **cast** of named characters keeps shots consistent, and layers can override it.
- **Rigs:** the global `src/rigs/` library, plus each project's own rigs.
- **Audio:** shots bring their cues, shifted and trimmed, with trackable volume. The main scene can add a music bed.
- **Export and the viewer.** Exporting the main scene exports the whole video. The viewer shows shot bands and opens a shot at the matching frame.
- **Agents.** Project rigs are writable by default. A `project.json` edit waits until no other thread in the project works, and is covered by Revert to here.
- **MCP** gains `list_projects`, `get_project` and `update_project`, and takes qualified ids.

