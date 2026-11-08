# M15 plan: the timeline as an editor

Built on 2026-11-07, with the recommended answer to all four decisions. See ADR 0018. One correction: pictures could already be placed from the Library, so only scenes needed a way onto a composition.

## What the code has

| Roadmap item | State |
| --- | --- |
| Clip move, trim both edges | Done, with keys, masks and overrides following the clip (`moveClip` in `tools/studio/server.ts`) |
| Undo, redo, lock while an agent works | Done |
| Snap to frames | Done for clips |
| Snap to other edges | Range and key drags only. Clip drags round to the frame and nothing else |
| Snap to the playhead | Nowhere yet. `snapFrame` and `snapDelta` take a target list, so this is one more target |
| Split, duplicate | Missing |
| Delete | Keys only. Delete does nothing to a selected clip |
| Waveforms | Done: `SoundBand` draws them on scenes and compositions |
| Move and trim sound | Missing. Bands are read-only, and only a voice row's words can be edited, on scenes |
| Fades on sound | Rendered (`fadeIn`, `fadeOut`, linear, `src/audio/media.ts`). No handles |
| Transition presets | Missing. Masks and opacity keys render, but `iris` exists only in `projects/bears-story/rigs`, and there's no wipe rig |

Missing and not on the list:

- Rows are laid out by overlap, not from the composition's tracks (`shotBands` in `src/viewer/app.ts`). Stacking order can't be seen, and a clip can't change track.
- A clip can only be added by an agent or in JSON. The viewer can't place a scene or picture on a composition.
- Edit > Undo clicked with the mouse does nothing to hand edits.

## Order of work

1. Clip operations in one server route: add, split, duplicate, delete, each one undo step. The undo stack holds layer changes today, so it needs to add and remove a clip. Split's acceptance test: every frame renders the same before and after.
2. Snapping: clip move and trim land on the playhead, other clips' edges and markers. The playhead joins every drag's targets.
3. Real track rows, moving a clip between tracks, adding a track.
4. Sound: move and trim cues, fade handles, one undo stack.
5. Transitions: built-in `iris` and `wipe` mask rigs, and a preset menu on a clip.
6. Edit > Undo reaches the viewer's history.

Keys: S splits, Command-D duplicates, Delete deletes. All three are free.

## Decisions for the user

1. **The composition cue limit.** A scene can't read a composition's cue, so captions need the voice in a scene.
   - A (recommended): keep the limit, and add "Move to a voice scene". It moves the cue into a new scene with a captions layer and places that as a clip. Sound and captions then move and trim together, one copy of the words exists, and no ADR changes.
   - B: a clip's scene reads its parent's cues. It breaks "a clip renders identically inside its composition and on its own", since the scene alone shows no captions, and needs amendments to ADR 0013 and ADR 0016.
   - C: captions as a clip kind on the composition. It breaks "compositions never draw", the core of ADR 0013.
2. **Transitions as data.**
   - A (recommended): a preset writes plain mask and opacity keys on the clip. No schema change, an agent can edit the result, and keys already follow a move. Clearing a preset drops the clip's mask and opacity track.
   - B: a `transition` field the engine expands. Easier to retime, but it's schema and engine work for something masks already draw.
3. **Sound rows.** Keep cues in `audio[]`, in rows by overlap (recommended), or give cues a track. The first changes no format. And editing covers scenes as well as compositions (recommended), since voices live in scenes.
4. **No ripple.** Delete leaves a gap, and split acts on the selected clip only (recommended). Ripple can come later. Multi-select stays refused (ADR 0003).
