// The stdio-to-HTTP relay behind tools/mcp/server.ts and the app's
// frame-studio-mcp command (ADR 0008). Node only.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { connectStudio, type Connected } from '../studio/connect.ts';
import { studioFolder } from '../studio/folder.ts';
import { SESSION_HEADER } from '../studio/mcp-http.ts';
import type { StudioServerOptions } from '../studio/server.ts';

export interface ShimOptions {
  /** Where the viewer comes from if the shim starts its own server: the repo's Vite, or the app's built files. */
  viewer?: StudioServerOptions['viewer'];
  /** The built-in sources, for the app. */
  builtins?: string;
}

export async function runShim(options: ShimOptions = {}): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { folder: { type: 'string' } }, strict: false });
  const folder = studioFolder(resolve(typeof values.folder === 'string' ? values.folder : process.cwd()), options.builtins ? { builtins: options.builtins } : {});
  const session = `mcp-${process.pid}`;
  const log = (line: string) => process.stderr.write(`[frame-studio] ${line}\n`);

  const stdio = new StdioServerTransport();
  let connected: Connected | null = null;
  /** The endpoint, made once: calls that arrive together share it, so only one server starts. */
  let endpoint: Promise<StreamableHTTPClientTransport> | null = null;

  function connect(): Promise<StreamableHTTPClientTransport> {
    endpoint ??= (async () => {
      connected ??= await connectStudio(folder, { ...(options.viewer ? { viewer: options.viewer } : {}), log });
      const transport = new StreamableHTTPClientTransport(new URL(`${connected.url}/__studio/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${connected.token}`, [SESSION_HEADER]: session } },
      });
      transport.onmessage = (message) => void stdio.send(message);
      transport.onerror = (err) => log(`MCP: ${err.message}`);
      await transport.start();
      return transport;
    })().catch((err: unknown) => {
      endpoint = null;
      throw err;
    });
    return endpoint;
  }

  /** True when the server wasn't there at all, so the message never reached it and can go again safely. */
  const unreachable = (err: unknown) => /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(`${err instanceof Error ? err.message : String(err)} ${String((err as { cause?: { code?: string } })?.cause?.code ?? '')}`);

  const relay = async (message: JSONRPCMessage) => {
    const id = (message as { id?: string | number }).id;
    const fail = (err: unknown) =>
      id === undefined
        ? undefined
        : stdio.send({ jsonrpc: '2.0', id, error: { code: -32603, message: `Frame Studio's server did not answer: ${err instanceof Error ? err.message : String(err)}` } });
    try {
      await (await connect()).send(message);
    } catch (first) {
      // Only when the server has gone (the app quit, say): find or start another, and send once more.
      // Anything else may have run already, so it isn't sent twice.
      if (!unreachable(first)) return void (await fail(first));
      try {
        const old = endpoint;
        endpoint = null;
        await (await old?.catch(() => null))?.close().catch(() => {});
        if (connected?.server === null) connected = null;
        await (await connect()).send(message);
      } catch (err) {
        await fail(err);
      }
    }
  };
  stdio.onmessage = (message) => void relay(message);
  await stdio.start();

  const shutdown = async () => {
    try {
      await (await endpoint?.catch(() => null))?.close();
      await connected?.close();
    } finally {
      process.exit(0);
    }
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
