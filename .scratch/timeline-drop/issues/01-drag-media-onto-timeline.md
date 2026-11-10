# Drag Library items onto the timeline

Type: task
Status: resolved

## Problem

Nothing in the Library can be dragged onto the timeline. Every video editor lets you drag from the media pool into the timeline. Ours has "Add at playhead" on each media row and the timeline corner's Clip button, both of which place at the playhead, so putting something at 0:04 means seeking there first. The Library also covers the dock, so even a working drag would have nowhere to land.

## Behaviour

- Media rows (sound, video and image files in `media/`) and scene and composition cards in the Library are draggable.
- A drop on the timeline places the item at the drop time, not the playhead. Either edge snaps to the playhead, markers and other edges within 6 px, as clip drags do (ADR 0018). While it hovers, the timeline shows an insert line at the start, a ghost span where it would go, and a note saying what will happen.
- In a composition, a scene, composition or picture becomes a clip on the track under the pointer. Dropped above the tracks it goes on a new track on top, below them on a new track at the bottom, and on a track with no room on a new track straight above that one. A sound file becomes a cue at the drop time. The server applies the same placement and validation as `add-clip` and `/sounds`, and refusals (loops, nesting depth, missing size) show in the selection bar as theirs do.
- In a scene, a sound file becomes a cue at the drop time. Pictures and scenes can't go in a scene (ADR 0014). The hover note says so in red, and a drop puts the same words in the selection bar.
- Each drop is one undo step on the shared Command-Z stack, saved through the server's checked edit, and locked while an agent works on the scene (ADR 0015).
- Files dropped from the computer onto the timeline import into `media/`, then land as a Library item would. Anywhere else in the window they import as before.
- Opened over the scene you came from, the Library stops at the dock, which stays in view and usable. Command-Z reaches the hand edits there.

## Acceptance

- [x] Unit tests cover what an item becomes where, its length in frames, the snapped start, the track under the pointer, and `add-clip`'s `into` (`src/viewer/drop.test.ts`, `src/studio/timeline-edit.test.ts`).
- [x] `tests/browser/timeline-drop.test.ts` drags a scene card and media rows onto a composition's timeline with the mouse, and checks the saved JSON, the hover note, snapping to a marker, new tracks above, below and over a full track, and Command-Z.
- [x] The same test refuses a picture and a scene in a scene with a note, places sound there, and imports and places a file dropped from the computer.
- [x] `npm run typecheck` and `npm test` pass, as do the timeline, media, picture, folder and viewer browser tests.

## Outcome

Built on 2026-11-10 on branch `timeline-drop`.

- The dock had no way to show under the Library: `.library` filled `.main` down to the bottom and the dock was `inert` while home. The fix is the smallest that gives a drag a target. When the Library is open over the scene you came from (`homeReturn`, so a header to go back to), it stops at the dock's measured height and the dock stays live. A project that opens straight on the Library shows no dock, since no scene was chosen. Open one, then come back.
- `src/viewer/drop.ts` holds the pure maths. `add-clip` takes `into: 'track' | 'top' | 'bottom'`. Without it, behaviour is unchanged.
- Drops keep the Library open, unlike "Add at playhead", which closes it. Several things can go in one after another.
