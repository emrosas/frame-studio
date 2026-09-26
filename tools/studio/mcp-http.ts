// The studio tools over MCP's streamable HTTP transport (ADR 0006, ADR 0008).
// Two kinds of caller:
// - Agents the studio server runs. Each turn gets a bearer token that says
//   which thread, turn and access the calls belong to, so the access rules
//   and frame thumbnails can follow them. T3 Code serves its tools to every
//   provider the same way.
// - External agents, through the frame-studio-mcp shim, with the server's
//   pairing token. They also get the request queue's tools, and name their
//   session in the X-Frame-Studio-Session header.
// Stateless: every POST gets a fresh server and transport over the one shared
// workspace. Node only.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerStudioTools, type ToolHooks } from '../mcp/tools.ts';
import type { Workspace } from '../mcp/workspace.ts';
import type { StudioQueue } from './queue.ts';

/** The header an external agent's shim names its session in. */
export const SESSION_HEADER = 'x-frame-studio-session';

export class McpEndpoint {
  private readonly hooks = new Map<string, ToolHooks>();
  private readonly workspace: () => Promise<Workspace>;
  private readonly serial: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly pairingToken: string | null;
  private readonly queue: StudioQueue | null;

  /** With `pairingToken` and `queue`, external agents may call too, with the queue's tools. */
  constructor(workspace: () => Promise<Workspace>, serial: <T>(fn: () => Promise<T>) => Promise<T>, pairingToken: string | null = null, queue: StudioQueue | null = null) {
    this.workspace = workspace;
    this.serial = serial;
    this.pairingToken = pairingToken;
    this.queue = queue;
  }

  /** The studio tools on an in-process MCP server, for a provider that can host one (the Claude Agent SDK). */
  server(hooks: ToolHooks): McpServer {
    const server = new McpServer({ name: 'frame-studio', version: '0.1.0' });
    registerStudioTools(server, { workspace: this.workspace, serial: this.serial, hooks });
    return server;
  }

  /** The studio tools plus the request queue's, for an external agent. */
  private externalServer(hooks: ToolHooks): McpServer {
    const server = new McpServer({ name: 'frame-studio', version: '0.1.0' });
    registerStudioTools(server, { workspace: this.workspace, serial: this.serial, hooks, ...(this.queue ? { requests: { selections: this.queue } } : {}) });
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
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    let hooks = this.hooks.get(bearer);
    let external = false;
    if (!hooks && this.pairingToken !== null && bearer === this.pairingToken) {
      const named = String(req.headers[SESSION_HEADER] ?? '');
      hooks = { session: /^[\w.:-]{1,80}$/.test(named) ? named : 'mcp-external' };
      external = true;
    }
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
    const server = external ? this.externalServer(hooks) : this.server(hooks);
    // Answers stream as server-sent events: headers go at once and keep-alives follow, so a tool that takes
    // minutes (an export queued behind another) doesn't hit a client's header timeout.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
