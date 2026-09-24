# M4: Single-file HTML embed

Type: task
Status: resolved
Blocked by: 07

## Work

Build milestone M4 as written in `docs/ROADMAP.md`.

## Answer

M4 is done and its four acceptance criteria pass. `docs/PROGRESS.md` records how each was checked.

- `npm run export -- --scene <id> --target html` writes one HTML file holding the engine, the player (`src/embed/player.ts`), only the rigs the scene uses, and the scene. `bear-test` is 54.2 KB after stripping rig and param descriptions, of which the engine and player are about 8.5 KB.
- Opened from disk with the network off, it makes no request but the file itself. Its frames match `render.html` byte for byte in the same browser launch.
- It plays on load and loops, and takes `?autoplay=0`, `?loop=0` and `?frame=n`. Host pages use `window.studio` from the same origin, or `postMessage` from any origin, and the embed answers every message with its state.
- The embed ships no validator. Scenes are validated when exported.
- A `/code-review` at high effort found ten issues, and all ten are fixed.
