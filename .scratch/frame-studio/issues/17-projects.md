# Projects: many scenes, one longer video

Type: grilling
Status: needs-triage
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
