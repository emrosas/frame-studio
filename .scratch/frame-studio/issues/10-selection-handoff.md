# How does a selection reach the agent?

Type: grilling
Status: resolved
Blocked by: 09

## Question

In M6 the viewer produces `{ sceneId, layerId, partId?, from, to }` plus prompt text and reference image paths. How does that payload get to the agent? Options include the clipboard, a file the MCP server reads, and an MCP resource. Consider what the user does next in their coding agent, and whether the viewer and the MCP server run as one process.

## Answer

Settled with the user on 2026-09-24 and recorded in `docs/adr/0003-selection-handoff-file-queue.md`. ADR 0001 was amended to match, and the integrated-AI direction went into ADR 0004.

- The viewer and the MCP server stay separate processes and share files in `.frame-studio/`, which is gitignored. The files are the source of truth, and the UI only displays them.
- `.frame-studio/selection.json` is always the current selection. Each ask is a queued request file carrying the selection, the frame on screen, the click point, the prompt and reference paths. References are copied into `references/`.
- Any agent can use it. "Send to agent" copies a line to paste, and MCP tools `next_request`, `get_request`, `complete_request` and `get_selection` serve the queue. Claude Code also gets `/frame-studio:next` and `@frame-studio:selection://current`. There are no push channels while they're in preview.
- Requests move from pending to in progress, then done or failed. They show as stalled after 10 minutes. Claims are atomic renames. The viewer shows the queue and a **View** notice when a request finishes.
- Checkpoints: a scene snapshot is taken when a request is claimed. **Revert** and **Try again** are offered on the newest request for each scene.
- The viewer talks to one studio server protocol: a Vite dev-server plugin now, and later a standalone Node server that Electron starts, as in T3 Code.
- The integrated AI (subscription or BYOK) becomes milestone M8, built last. It reads the same requests.

Findings behind the choices: MCP client capabilities (Claude Code, Codex, Cursor, the MCP spec) and T3 Code's architecture, summarised in the ADRs.
