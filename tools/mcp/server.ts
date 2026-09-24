// Frame Studio's MCP server, over stdio: the coding agent's API to the studio
// (CLAUDE.md, "MCP server"). Register it with your agent as
//   node tools/mcp/server.ts
// from the repo root. docs/MCP.md has setup and the tool list.
//
// stdout carries the protocol, so nothing here may print to it; diagnostics
// go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STUDIO_DIR } from '../studio/plugin.ts';
import { StudioQueue } from '../studio/queue.ts';
import { Workspace } from './workspace.ts';

const frame = z
  .union([z.number().int().min(0), z.string()])
  .describe('A frame number, or an MM:SS:FF timecode where FF is the frame within the second');
const sceneId = z.string().describe('Scene id, as list_scenes shows it');
const paramValue = z.union([z.number(), z.string(), z.boolean()]);

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (err: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
});

let workspace: Promise<Workspace> | null = null;
/** The workspace, started on first use. A failed start is forgotten, so the next call tries again. */
const ws = () =>
  (workspace ??= Workspace.open().catch((err) => {
    workspace = null;
    throw err;
  }));

// The SDK runs requests concurrently, but the tools share one page and read, patch and write scene
// files, and the /next prompt claims requests and copies scenes. One of them runs at a time.
let turn: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = turn.then(fn);
  turn = run.catch(() => {});
  return run;
}

/** Runs a tool body in turn, turning any error into a readable tool error instead of a protocol error. */
function tool<A>(body: (w: Workspace, args: A) => Promise<CallToolResult>) {
  return (args: A): Promise<CallToolResult> =>
    serial(async () => {
      try {
        return await body(await ws(), args);
      } catch (err) {
        return failure(err);
      }
    });
}

/** Reads the viewer's current selection straight from its file, without starting Vite or a browser. */
const selections = new StudioQueue(STUDIO_DIR, async () => {
  throw new Error('reading the selection needs no scene file');
});

const server = new McpServer({ name: 'frame-studio', version: '0.1.0' });

server.registerTool(
  'list_scenes',
  {
    title: 'List scenes',
    description: 'Every scene in scenes/: id, file, fps, duration, frame count, size, layers, and any validation errors.',
    annotations: { readOnlyHint: true },
  },
  tool(async (w) => text(await w.listScenes())),
);

server.registerTool(
  'get_scene',
  {
    title: 'Get a scene',
    description: 'The scene JSON exactly as it is in its file, plus the file path and any validation errors. Frame ranges are [from, to), and key times are in seconds.',
    inputSchema: { id: sceneId },
    annotations: { readOnlyHint: true },
  },
  tool(async (w, { id }: { id: string }) => text(await w.getScene(id))),
);

server.registerTool(
  'update_scene',
  {
    title: 'Update a scene',
    description:
      'Applies an RFC 7386 JSON merge patch to the scene file: objects merge key by key, null deletes a key, and arrays are replaced whole, so to change one layer send the whole layers array. The result is validated before saving; if it is invalid nothing is saved and the errors say why. The id cannot change.',
    inputSchema: { id: sceneId, patch: z.record(z.string(), z.unknown()).describe('JSON merge patch') },
  },
  tool(async (w, { id, patch }: { id: string; patch: Record<string, unknown> }) => text(await w.updateScene(id, patch))),
);

server.registerTool(
  'list_rigs',
  {
    title: 'List rigs',
    description: "Every rig: its param schema (type, default, range, options, description), the parts it declares for selection, its variants (e.g. bear.bandaged) and, for a variant, its base. A variant takes every param of its base.",
    annotations: { readOnlyHint: true },
  },
  tool(async (w) => text(await w.listRigs())),
);

server.registerTool(
  'render_frame',
  {
    title: 'Render a frame',
    description: 'Renders one frame so you can see it. Writes the full-size PNG to out/<scene>/ and returns a preview at most maxWidth wide.',
    inputSchema: { sceneId, frame, maxWidth: z.number().int().min(64).max(3840).default(1280).describe('Preview width limit in pixels') },
    annotations: { readOnlyHint: true },
  },
  tool(async (w, { sceneId: id, frame: f, maxWidth }: { sceneId: string; frame: number | string; maxWidth: number }) => {
    const r = await w.renderFrame(id, f, maxWidth);
    return {
      content: [
        { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${id} frame ${r.frame}, preview ${r.width}x${r.height}. Full size: ${r.file}` },
      ],
    };
  }),
);

server.registerTool(
  'render_contact_sheet',
  {
    title: 'Render a contact sheet',
    description: 'A grid of every Nth frame of [from, to), each labelled with its frame and timecode, for reviewing motion. Without every, about 24 frames. Writes the PNG to out/<scene>/ and returns it.',
    inputSchema: {
      sceneId,
      from: frame.optional().describe('First frame, included. Defaults to 0'),
      to: frame.optional().describe('Last frame, excluded. Defaults to the end'),
      every: z.number().int().min(1).optional(),
      columns: z.number().int().min(1).max(12).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async (w, args: { sceneId: string; from?: number | string; to?: number | string; every?: number; columns?: number }) => {
    const r = await w.contactSheet(args.sceneId, args);
    return {
      content: [
        { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `${args.sceneId}: frames ${r.sheet.frames.join(', ')} (${r.sheet.width}x${r.sheet.height}). File: ${r.file}` },
      ],
    };
  }),
);

server.registerTool(
  'hit_test',
  {
    title: 'Hit test',
    description:
      'Which layer, and which of its parts, is at scene pixel (x, y) on a frame. Scene pixels run from the top-left, at the scene size list_scenes reports. Also lists every layer with paint there, top first, with its share of the pixel.',
    inputSchema: { sceneId, frame, x: z.number().describe('Scene pixels from the left'), y: z.number().describe('Scene pixels from the top') },
    annotations: { readOnlyHint: true },
  },
  tool(async (w, { sceneId: id, frame: f, x, y }: { sceneId: string; frame: number | string; x: number; y: number }) =>
    text(await w.hitTest(id, f, x, y)),
  ),
);

server.registerTool(
  'apply_to_selection',
  {
    title: 'Apply to a selection',
    description:
      'A scoped edit: over frames [from, to) of one layer, swap its rig to a variant and/or override params, written as overrides in the scene file. Overrides the range partly covers are split so they keep applying outside it. Use layerId "background" for the background. Leave out layerId to select the whole frame range: params then go to every layer whose rig takes all of them. Frames outside the range are untouched. The result is validated before saving.',
    inputSchema: {
      selection: z.object({
        sceneId,
        layerId: z.string().optional().describe('Layer id, e.g. from hit_test; "background" for the background; leave out for every layer'),
        partId: z.string().optional().describe('Accepted, but params apply to the whole layer'),
        from: frame.describe('First frame, included'),
        to: frame.describe('Last frame, excluded'),
      }),
      patch: z.object({
        rig: z.string().optional().describe('A rig or variant id to draw with over the range, e.g. bear.bandaged'),
        params: z.record(z.string(), paramValue).optional().describe('Param values to hold over the range'),
      }),
    },
  },
  tool(
    async (
      w,
      { selection, patch }: { selection: { sceneId: string; layerId?: string; partId?: string; from: number | string; to: number | string }; patch: { rig?: string; params?: Record<string, number | string | boolean> } },
    ) => text(await w.applyToSelection(selection, patch)),
  ),
);

server.registerTool(
  'export',
  {
    title: 'Export',
    description:
      'Exports a scene. mp4 is H.264 at the scene fps, gif loops, and html is a single self-contained file that draws the scene live with no network requests. mp4 and gif take an optional [from, to) range; html is always the whole scene. Returns the output path.',
    inputSchema: {
      sceneId,
      target: z.enum(['mp4', 'gif', 'html']),
      from: frame.optional(),
      to: frame.optional(),
    },
  },
  tool(async (w, { sceneId: id, target, from, to }: { sceneId: string; target: 'mp4' | 'gif' | 'html'; from?: number | string; to?: number | string }) =>
    text(await w.export(id, target, { from, to })),
  ),
);

// ---- The viewer's request queue (ADR 0003) ----

const noneWaiting = 'There are no pending Frame Studio requests. Send one from the viewer: select something, write a prompt, and press Send to agent.';

server.registerTool(
  'next_request',
  {
    title: 'Take the next request',
    description:
      "Claims the oldest pending request from the viewer's queue and returns it: the prompt, the selection (scene, layer, part, frame range), the frame on screen, where the user clicked, and reference image paths. The scene is saved first so the user can revert. Call complete_request when you finish.",
  },
  tool(async (w) => {
    const request = await w.nextRequest();
    return text(request ? `${await w.describeRequest(request)}\n\n${JSON.stringify(request, null, 2)}` : noneWaiting);
  }),
);

server.registerTool(
  'get_request',
  {
    title: 'Get a request',
    description: 'A request from the viewer by id, as in a line the user pasted ("Frame Studio request #7 ..."). If it is still pending, this claims it for you and saves the scene first, so the user can revert. Call complete_request when you finish.',
    inputSchema: { id: z.number().int().min(1).describe('The request number') },
  },
  tool(async (w, { id }: { id: number }) => {
    const request = await w.getRequest(id);
    return text(`${await w.describeRequest(request)}\n\n${JSON.stringify(request, null, 2)}`);
  }),
);

server.registerTool(
  'complete_request',
  {
    title: 'Complete a request',
    description: 'Marks a request you worked on as done or failed, with a one-line summary the user sees in the viewer, e.g. "set pip\'s expression to sad over frames 24 to 48".',
    inputSchema: {
      id: z.number().int().min(1),
      status: z.enum(['done', 'failed']),
      summary: z.string().min(1).describe('One line: what you changed, or why it failed'),
    },
  },
  tool(async (w, { id, status, summary }: { id: number; status: 'done' | 'failed'; summary: string }) => text(await w.completeRequest(id, status, summary))),
);

server.registerTool(
  'get_selection',
  {
    title: 'Get the current selection',
    description: "What the user has selected in the viewer right now: scene, layer, part, frame range [from, to), the frame on screen and where they clicked. Use it when the user says \"this\" or \"the selection\" without sending a request.",
    annotations: { readOnlyHint: true },
  },
  () =>
    serial(async () => {
      try {
        return text((await selections.readSelection()) ?? 'Nothing is selected in the viewer.');
      } catch (err) {
        return failure(err);
      }
    }),
);

server.registerPrompt(
  'next',
  {
    title: 'Next Frame Studio request',
    description: "Takes the oldest pending request from the viewer's queue and starts on it.",
  },
  () =>
    serial(async () => {
      try {
        const w = await ws();
        const request = await w.nextRequest();
        const body = request ? `Please work on this Frame Studio request.\n\n${await w.describeRequest(request)}` : noneWaiting;
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }] };
      } catch (err) {
        const message = `Frame Studio could not read its queue: ${err instanceof Error ? err.message : String(err)}`;
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: message } }] };
      }
    }),
);

server.registerResource(
  'selection',
  'selection://current',
  { title: 'Current selection', description: "What is selected in the Frame Studio viewer right now.", mimeType: 'application/json' },
  (uri) =>
    serial(async () => {
      const selection = await selections.readSelection();
      const body = selection ?? { selection: null, note: 'Nothing is selected in the viewer.' };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    }),
);

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
