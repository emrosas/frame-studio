# M5: MCP server

Type: task
Status: resolved
Blocked by: 08

## Work

Build milestone M5 as written in `docs/ROADMAP.md`.

## Answer

M5 is done and its two acceptance criteria pass. `docs/PROGRESS.md` records how each was checked, and `docs/MCP.md` covers setup and the tools.

- `node tools/mcp/server.ts` serves the nine tools over stdio. The repo's `.mcp.json` registers it for Claude Code.
- A real MCP client session, in `tests/browser/mcp.test.ts`, lists scenes, renders, hit-tests `bruno`, applies a scoped edit over frames 12 to 24, and re-renders. Frames 12 and 23 changed, and frames 11 and 24 stayed identical. Then it exports mp4, gif and html.
- Edits validate before saving. `apply_to_selection` splits overrides the range partly covers, and a selection without a layer covers the whole range. Scene files are written in one compact format, and all of them were reformatted to it once.
- A `/code-review` at high effort found ten issues, and all ten are fixed. The main one: tool calls now run one at a time.
