# M8: Integrated AI

Type: task
Status: resolved
Blocked by: 16

## Work

Build milestone M8 as written in `docs/ROADMAP.md`, as ticket 16 settled it (`docs/adr/0006-requests-are-threads.md`). The provider findings in `research/integrated-ai-providers.md` apply. T3 Code (github.com/pingdotgg/t3code, MIT) is the reference for the provider adapters, the event stream and approvals.

## Answer

M8 is done and its acceptance criteria pass. `docs/PROGRESS.md` records how each was checked, and ADR 0006 has what building it changed.

- **Requests are threads**, with a checkpoint per turn, Revert to here, Try again and Settle. A per-scene lock keeps one working thread per scene across processes.
- **The studio runs Claude and Codex** through the user's own signed-in CLIs, plus a scripted test agent.
  - Claude runs through the Agent SDK, with the studio tools in-process and `canUseTool` applying the access rules.
  - Codex runs through `codex app-server` over stdio, with its approvals, including MCP tool calls, answered through the same rules.
- **The left panel** streams each turn: text, steps, frame thumbnails and approval cards. It has an agent picker with model, effort and full access, and says how to fix an agent that isn't ready.
- **The external agent works threads** through the same MCP tools.
- **Real runs:** Claude and Codex each worked a turn through the studio, and Codex resumed its session on a reply. Claude also ran through the viewer.
- **Reviews:** two agents reviewed M8. Their fixes include refusing non-local connections, a lock that holds under concurrency, and turn ownership on complete.

