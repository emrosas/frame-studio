# M6: Selection-to-prompt in the viewer

Type: task
Status: resolved
Blocked by: 09, 10

## Work

Build milestone M6 as written in `docs/ROADMAP.md`, using the handoff settled in ticket 10. Picking a layer by clicking and setting a frame range land early, in M2 (ticket 06). M6 adds the prompt text, reference images and the payload handoff on top of them.

Build the handoff exactly as ticket 10 settled it (`docs/adr/0003-selection-handoff-file-queue.md`), over the studio server protocol in ADR 0001. That covers the request queue, the MCP request tools, the Claude Code prompt and resource, the queue panel, and checkpoints with Revert and Try again. The roadmap's M6 section lists the pieces.

Start by moving the viewer's UI to Svelte 5, as `docs/adr/0002-svelte-from-m6.md` describes, then build the M6 panels as components. The user also wants an iteration modal for edits, and the ticket 13 studies (`bears-gouache`, `bears-pastel`, `bears-watercolor`) are kept as material for testing it.

## Answer

M6 is done and its acceptance criteria pass. `docs/PROGRESS.md` records how each was checked.

- The viewer's UI is Svelte 5 now (ADR 0002). Behaviour tests written before the port passed unchanged. The repo moved to TypeScript 6 so svelte-check can run.
- The handoff is built as ADR 0003 describes. There's a request queue in `.frame-studio/` with atomic create and claim, checkpoints, revert, retry, and archiving. A studio server plugin serves `/__studio/` to the viewer, same-origin only. MCP gets the request tools, the `/frame-studio:next` prompt and the `selection://current` resource. The Requests panel has the composer, the queue, and the finished notice with View.
- While a range is selected, playback loops inside it.
- Both acceptance flows were run: through tests, and once for real, with me playing the agent. That run produced the `bear.blush` variant, confirmed the reference image appears in no scene or export, and was reverted from the viewer.
- A `/code-review` at high effort found ten issues, including a cross-site request hole in the studio server, and all ten are fixed.
