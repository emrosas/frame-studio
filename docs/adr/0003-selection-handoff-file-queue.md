# 0003: Selections reach the agent through a file queue

Status: accepted, 2026-09-24 (ticket 10)

## Context

The canvas is the selection surface. You click a layer or part, pick a frame range, and ask for a change. The ask then has to reach a coding agent. The viewer and the MCP server are separate processes. The viewer is a Vite dev server that runs with or without an agent. The MCP server starts and stops with each agent session, and it already watches `scenes/`. Every MCP client supports tools. Claude Code also turns MCP prompts into slash commands and lets you @-mention resources, but nothing in it can push into a session except channels, which are a research preview.

## Decision

- **Files are the source of truth.** Everything lives in `.frame-studio/`, which is gitignored. The viewer writes through its studio server (ADR 0001) and the MCP server writes directly. Neither keeps state in memory that the other needs.
- **The current selection:** `.frame-studio/selection.json` holds `{ sceneId, layerId?, partId?, from, to, frame, point? }`. The viewer rewrites it 300 ms after the selection stops changing and clears it on deselect. Without a `layerId` it means the whole frame range.
- **The request queue:** each ask is its own file, `.frame-studio/requests/NNNN.json`, with ids counting up from 1. It holds the selection, the frame on screen, the click point, the prompt, and reference image paths. It holds no image; the agent calls `render_frame` and `hit_test` to see. A request moves from pending to in progress, then done or failed, and the viewer shows it as stalled after 10 minutes in progress. The MCP server claims a request by renaming its file, which is atomic, so two agent sessions never take the same one.
- **Reference images** are copied into `references/` under readable unique names: PNG, JPEG or WebP, up to 20 MB each. Requests list their repo-relative paths. They stay agent input only (`CLAUDE.md`).
- **Getting it to the agent.** It works with any MCP client:
  - The viewer's "Send to agent" writes the request and copies a one-line summary to paste into any agent.
  - MCP tools: `next_request` (claims the oldest pending request), `get_request(id)`, `complete_request(id, status, summary)` and `get_selection`. Every request tells the agent to call `complete_request` when it finishes.
- **Claude Code extras:**
  - a `/frame-studio:next` slash command, served as an MCP prompt, that hands the agent the next request
  - `@frame-studio:selection://current`, a resource for the selection
  - no channels until they leave preview
- **Checkpoints:**
  - When the agent claims a request, the MCP server copies the scene file to `.frame-studio/requests/NNNN.before.json`. Since the copy is taken at claim time, it also covers edits the agent makes to scene files directly.
  - **Revert** restores the copy.
  - **Try again** reverts, then queues the same selection, prompt and references as attempt N of the same request. You can edit the prompt first.
  - Both are offered only on the newest request for each scene, so reverting never throws away a later edit. Rig code is left to git.
- **The viewer's queue list** shows each request's prompt, range, status and summary. Clicking a request restores its selection. You can cancel a pending request and requeue a stalled one. When one finishes, a notice offers **View**, which jumps to its range and loops it. Done requests stay until you clear them.

## Consequences

- Restarting the viewer, the agent or the MCP server loses nothing, and the whole queue can be read on disk.
- Progress notes from the agent while it works are left out for now; the stall rule covers "is anything happening?"
- Several attempts side by side, as branches to compare, are left for later. Try again replaces the attempt before it.
- The integrated AI (ADR 0004) will read the same request files, so the request format is the contract between the viewer and any agent.
