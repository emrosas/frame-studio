// Frame Studio's MCP server, over stdio: the coding agent's API to the studio
// (CLAUDE.md, "MCP server"). Register it with your agent as
//   node tools/mcp/server.ts
// from the repo root. docs/MCP.md has setup and the tool list. The tools
// themselves are in tools.ts, shared with the studio server's own agents.
//
// stdout carries the protocol, so nothing here may print to it; diagnostics
// go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STUDIO_DIR } from '../studio/paths.ts';
import { StudioQueue } from '../studio/queue.ts';
import { createSerial, registerStudioTools } from './tools.ts';
import { Workspace } from './workspace.ts';

let workspace: Promise<Workspace> | null = null;
/** The workspace, started on first use. A failed start is forgotten, so the next call tries again. */
const ws = () =>
  (workspace ??= Workspace.open().catch((err) => {
    workspace = null;
    throw err;
  }));

/** Reads the viewer's current selection straight from its file, without starting Vite or a browser. */
const selections = new StudioQueue(STUDIO_DIR, async () => {
  throw new Error('reading the selection needs no scene file');
});

const server = new McpServer({ name: 'frame-studio', version: '0.1.0' });
// The SDK runs requests concurrently, but the /next prompt claims requests and copies scenes too, so everything takes turns.
registerStudioTools(server, { workspace: ws, serial: createSerial(), requests: { selections } });

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  try {
    await (await workspace)?.close();
  } finally {
    process.exit(0);
  }
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
