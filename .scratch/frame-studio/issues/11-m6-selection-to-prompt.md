# M6: Selection-to-prompt in the viewer

Type: task
Status: open
Blocked by: 09, 10

## Work

Build milestone M6 as written in `docs/ROADMAP.md`, using the handoff settled in ticket 10. Picking a layer by clicking and setting a frame range land early, in M2 (ticket 06). M6 adds the prompt text, reference images and the payload handoff on top of them.

Build the handoff exactly as ticket 10 settled it (`docs/adr/0003-selection-handoff-file-queue.md`), over the studio server protocol in ADR 0001. That covers the request queue, the MCP request tools, the Claude Code prompt and resource, the queue panel, and checkpoints with Revert and Try again. The roadmap's M6 section lists the pieces.

Start by moving the viewer's UI to Svelte 5, as `docs/adr/0002-svelte-from-m6.md` describes, then build the M6 panels as components. The user also wants an iteration modal for edits, and the ticket 13 studies (`bears-gouache`, `bears-pastel`, `bears-watercolor`) are kept as material for testing it.
