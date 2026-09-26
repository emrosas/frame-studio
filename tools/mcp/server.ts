// Frame Studio's MCP server for external agents, over stdio (CLAUDE.md, "MCP
// server"; ADR 0008). Register it with your agent as
//   node tools/mcp/server.ts
// from a studio folder (the repo is one), or pass --folder. docs/MCP.md has
// setup and the tool list. The app ships the same shim as frame-studio-mcp.
//
// It's a shim. The tools run in a studio server: the one the app or npm run
// dev runs on the folder, when there is one, so your renders and the viewer
// share it; otherwise a headless one it starts for the session. Every message
// goes through unchanged, to the server's MCP endpoint.
//
// stdout carries the protocol, so nothing here may print to it; diagnostics
// go to stderr.

import { join } from 'node:path';
import { REPO } from '../studio/folder.ts';
import { installLoader } from '../studio/loader.ts';

const builtins = process.env.FRAME_STUDIO_BUILTINS ?? join(REPO, 'src');
installLoader(builtins);
const { runShim } = await import('./shim.ts');
await runShim({ builtins });
