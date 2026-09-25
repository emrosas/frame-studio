// The studio tools over MCP's streamable HTTP transport, for the agents the
// studio server runs (ADR 0006). T3 Code serves its tools to every provider
// the same way. Each turn gets a bearer token; the token says which thread,
// turn and access the calls belong to, so the access rules and frame
// thumbnails can follow them. Stateless: every POST gets a fresh server and
// transport over the one shared workspace. Node only.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerStudioTools, type ToolHooks } from '../mcp/tools.ts';
import type { Workspace } from '../mcp/workspace.ts';

export class McpEndpoint {
  private readonly hooks = new Map<string, ToolHooks>();
  private readonly workspace: () => Promise<Workspace>;
  private readonly serial: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(workspace: () => Promise<Workspace>, serial: <T>(fn: () => Promise<T>) => Promise<T>) {
    this.workspace = workspace;
    this.serial = serial;
  }

  /** The studio tools on an in-process MCP server, for a provider that can host one (the Claude Agent SDK). */
  server(hooks: ToolHooks): McpServer {
    const server = new McpServer({ name: 'frame-studio', version: '0.1.0' });
    registerStudioTools(server, { workspace: this.workspace, serial: this.serial, hooks });
    return server;
  }

  /** A token for one turn's tool calls, and the hooks that see them. Revoke it when the turn ends. */
  issue(hooks: ToolHooks): string {
    const token = randomBytes(24).toString('base64url');
    this.hooks.set(token, hooks);
    return token;
  }

  revoke(token: string): void {
    this.hooks.delete(token);
  }

  /** Serves one HTTP request to the endpoint. Only POST: the stateless transport has no streams to resume. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = String(req.headers.authorization ?? '');
    const hooks = auth.startsWith('Bearer ') ? this.hooks.get(auth.slice('Bearer '.length)) : undefined;
    if (!hooks) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown or expired token.' }, id: null }));
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }
    const server = this.server(hooks);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
