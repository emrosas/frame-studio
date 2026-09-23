# M2: First character rig and hit testing

Type: task
Status: resolved
Blocked by: 01, 02, 05

## Work

Build milestone M2 as written in `docs/ROADMAP.md`, using the character settled in ticket 05 and the per-layer alpha probe from ticket 02 in place of the flat-colour ID pass.

The user asked on 2026-09-23 for a way to pick frames as well as objects in the viewer. So M2 also brings in frame-range picking: in and out points on the scrubber, typed timecodes and a selection readout. M6 keeps the handoff to the agent (prompt text, reference images and delivering the payload).

## Answer

M2 is done and its three acceptance criteria pass. `docs/PROGRESS.md` records how each one was checked.

- The character is the painted `bear`, with seven parts, four poses, four expressions, seeded blinks and a breath bob. `bear.bandaged` adds a plaster part through an override on `bruno` in `scenes/bear-test.json`, frames `[48, 72)`.
- `hitTest` uses per-layer alpha probes, as ticket 02 recommended. `CLAUDE.md` and `docs/ROADMAP.md` now describe the probes instead of the flat-colour ID pass.
- In the viewer, a click selects a layer, a repeat click steps down through the layers there, and Alt with a click picks the part. I and O or the from and to fields set the frame range. The selection highlight lives on an overlay canvas and hides during playback.
- A `/code-review` at high effort found ten issues. Eight are fixed, one in the docs, and hover probe cost is recorded as a known issue.
