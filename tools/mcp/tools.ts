// The studio's MCP tools, registered on any McpServer: the stdio server an
// external agent starts (server.ts), and the HTTP endpoint the studio server
// gives the agents it runs itself (ADR 0006). One definition, so both kinds of
// agent get exactly the same operations.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { NewProject, NewScene } from '../../src/studio/protocol.ts';
import type { StudioQueue } from '../studio/queue.ts';
import type { Workspace } from './workspace.ts';

const frame = z
  .union([z.number().int().min(0), z.string()])
  .describe('A frame number, or an MM:SS:FF timecode where FF is the frame within the second');
const sceneId = z.string().describe('Scene id, as list_scenes shows it: a loose scene\'s id, or "<project>/<scene>" in a project');
const projectId = z.string().describe('Project id, the folder name in projects/, as list_projects shows it');
/** How long update_project waits for the project's other threads before it refuses. Under Codex's 60 s tool timeout. */
const PROJECT_WAIT_MS = 50_000;
const paramValue = z.union([z.number(), z.string(), z.boolean()]);
const newId = z.string().describe('Lowercase letters, digits and single hyphens, like "opening-shot". It names the file, so it can\'t change later');
const fps = z.number().int().min(1).max(120).describe('Frames per second, e.g. 12, 24 or 30. With audio it must divide 48000');
const size = z.tuple([z.number().int(), z.number().int()]).describe('[width, height] in scene pixels, e.g. [1920, 1080]. MP4 needs both even');
const duration = z.number().positive().max(3600).describe('Length in seconds');

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const failure = (err: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
});

/** Runs tool bodies one at a time: they share one page and read, patch and write scene files. */
export function createSerial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let turn: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = turn.then(fn);
    turn = run.catch(() => {});
    return run;
  };
}

/** Lets the host see, and refuse, each tool call. The studio server uses it for access rules and frame thumbnails. */
export interface ToolHooks {
  /** Runs before a tool. Throwing refuses the call, and the message goes back to the agent. */
  before?(name: string, args: Record<string, unknown>): Promise<void>;
  /** Runs after a tool, with its result. */
  after?(name: string, args: Record<string, unknown>, result: CallToolResult): void | Promise<void>;
  /** False once the caller's turn has ended; its queued calls then fail instead of running. */
  active?(): boolean;
  /** The thread whose turn makes these calls, so a project edit doesn't wait for its own caller. */
  thread?: number;
  /** An external agent's session, which names its claims on the request queue. */
  session?: string;
}

export interface StudioToolsOptions {
  /** The workspace, started on first use. */
  workspace: () => Promise<Workspace>;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Adds the request queue's tools, the next prompt and the selection resource,
   * for an external agent. `selections` reads the selection file without
   * starting Vite. Agents inside the studio work one thread given to them, so
   * they get none of these.
   */
  requests?: { selections: StudioQueue };
  hooks?: ToolHooks;
}

export function registerStudioTools(server: McpServer, options: StudioToolsOptions): void {
  const { serial, hooks } = options;
  const ws = options.workspace;
  const caller = { ...(hooks?.thread !== undefined ? { thread: hooks.thread } : {}), ...(hooks?.session ? { session: hooks.session } : {}) };

  /**
   * Runs a tool body in turn, turning any error into a readable tool error instead of a protocol error.
   * The before hook runs first, outside the queue, since it may wait on the user, and then `prepare`, for
   * waits of the tool's own; the body then checks the caller is still active, so a call queued behind
   * others doesn't run after its turn ended.
   */
  function tool<A>(name: string, body: (w: Workspace, args: A) => Promise<CallToolResult>, prepare?: (w: Workspace, args: A) => Promise<void>) {
    return async (args: A): Promise<CallToolResult> => {
      const record = (args ?? {}) as Record<string, unknown>;
      try {
        await hooks?.before?.(name, record);
        if (prepare) await prepare(await ws(), args);
      } catch (err) {
        return failure(err);
      }
      return serial(async () => {
        try {
          if (hooks?.active && !hooks.active()) throw new Error('This turn has ended, so its tool calls no longer run.');
          const result = await body(await ws(), args);
          await hooks?.after?.(name, record, result);
          return result;
        } catch (err) {
          return failure(err);
        }
      });
    };
  }

  server.registerTool(
    'list_scenes',
    {
      title: 'List scenes',
      description:
        'Every scene: loose scenes in scenes/, then each project\'s, with ids qualified as "<project>/<scene>". For each: id, project (null when loose), file, fps, duration, frame count, size, layers (with the rig, cast member or placed scene each draws), and any validation errors.',
      annotations: { readOnlyHint: true },
    },
    tool('list_scenes', async (w) => text(await w.listScenes())),
  );

  server.registerTool(
    'get_scene',
    {
      title: 'Get a scene',
      description: 'The scene JSON exactly as it is in its file, plus the file path and any validation errors. Frame ranges are [from, to), and key times are in seconds.',
      inputSchema: { id: sceneId },
      annotations: { readOnlyHint: true },
    },
    tool('get_scene', async (w, { id }: { id: string }) => text(await w.getScene(id))),
  );

  server.registerTool(
    'update_scene',
    {
      title: 'Update a scene',
      description:
        'Applies an RFC 7386 JSON merge patch to the scene file: objects merge key by key, null deletes a key, and arrays are replaced whole, so to change one layer send the whole layers array. The result is validated before saving; if it is invalid nothing is saved and the errors say why. The id cannot change.',
      inputSchema: { id: sceneId, patch: z.record(z.string(), z.unknown()).describe('JSON merge patch') },
    },
    tool('update_scene', async (w, { id, patch }: { id: string; patch: Record<string, unknown> }) => text(await w.updateScene(id, patch))),
  );

  server.registerTool(
    'create_scene',
    {
      title: 'Create a scene',
      description:
        'Creates a new, empty scene: a paper background and no layers, to fill in with update_scene. A loose scene goes in scenes/<id>.json and needs fps and size. With project, it goes in projects/<project>/<id>.json and takes the project\'s fps and size, so leave them out. Refuses an id that is taken. Returns the scene id to use with the other tools.',
      inputSchema: { id: newId, project: projectId.optional(), fps: fps.optional(), size: size.optional(), duration },
    },
    tool('create_scene', async (w, input: NewScene) => text(await w.createScene(input))),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        "Every project in projects/: id, name, file, the fps and size every scene in it shares, main (the scene that places the shots, whose export is the whole video), the cast (named characters: a rig with params, used by layers as { \"cast\": \"name\" }), its scenes by qualified id, its own rigs, and any errors in project.json.",
      annotations: { readOnlyHint: true },
    },
    tool('list_projects', async (w) => text(await w.listProjects())),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description: "A project's project.json exactly as it is in its file, plus the file path, its scenes by qualified id, and any errors.",
      inputSchema: { id: projectId },
      annotations: { readOnlyHint: true },
    },
    tool('get_project', async (w, { id }: { id: string }) => text(await w.getProject(id))),
  );

  server.registerTool(
    'update_project',
    {
      title: 'Update a project',
      description:
        "Applies an RFC 7386 JSON merge patch to a project's project.json, e.g. { \"cast\": { \"bruno\": { \"params\": { \"fur\": \"#8a5a3c\" } } } } to change a character in every shot. A change here touches every scene in the project, so it waits (up to about 50 s) while another request in the project is working, and is refused if that work doesn't end. The result is validated, and every scene in the project must stay valid under it; if not, nothing is saved and the errors say why.",
      inputSchema: { id: projectId, patch: z.record(z.string(), z.unknown()).describe('JSON merge patch') },
    },
    tool(
      'update_project',
      async (w, { id, patch }: { id: string; patch: Record<string, unknown> }) => text(await w.updateProject(id, patch, caller)),
      (w, { id }) => w.waitForProject(id, caller, PROJECT_WAIT_MS),
    ),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description:
        'Creates a new project: projects/<id>/project.json with its name, fps and size, and an empty main scene, "<id>/main", whose export is the whole video. Add shots with create_scene and project, and place them in main as scene layers. Refuses an id that is taken.',
      inputSchema: { id: newId, name: z.string().min(1).max(100).describe('The name the sidebar shows, e.g. "Bears\' story"'), fps, size, duration: duration.describe("The main scene's length in seconds") },
    },
    tool('create_project', async (w, input: NewProject) => text(await w.createProject(input))),
  );

  server.registerTool(
    'list_rigs',
    {
      title: 'List rigs',
      description:
        "Every rig: its param schema (type, default, range, options, description), the parts it declares for selection, its variants (e.g. bear.bandaged) and, for a variant, its base. A variant takes every param of its base. A rig with a project belongs to that project's rigs/ folder, and only that project's scenes can use it.",
      annotations: { readOnlyHint: true },
    },
    tool('list_rigs', async (w) => text(await w.listRigs())),
  );

  server.registerTool(
    'list_generators',
    {
      title: 'List audio generators',
      description:
        "Every audio generator a scene's audio cues can use: its param schema (type, default, range, options, description). A cue is { id, generator, start, end, params } in seconds, and plays inside [start, end), snapped to frames.",
      annotations: { readOnlyHint: true },
    },
    tool('list_generators', async (w) => text(await w.listGenerators())),
  );

  server.registerTool(
    'list_media',
    {
      title: 'List sound files',
      description:
        'The sound files in the studio folder\'s media/ (voiceover, music), each with its path for a cue, size and, from its header, duration in seconds, channels and sample rate. A cue plays one with { "id", "file": "media/voice.mp3", "start", "end", "in"?, "fadeIn"?, "fadeOut"?, "tracks"? } in the scene\'s audio: from start to end in scene seconds, starting "in" seconds into the file, with fades in seconds and volume keys.',
      annotations: { readOnlyHint: true },
    },
    tool('list_media', async (w) => text(await w.listMedia())),
  );

  server.registerTool(
    'import_media',
    {
      title: 'Import a sound file',
      description:
        "Copies a sound file (MP3, WAV, M4A, AAC, FLAC, Ogg, Opus) from a path on this computer into the studio folder's media/, named after it and numbered if the name is taken, and returns its path for cues and its duration. Use it when the user points you at a file; never import anything they didn't ask for.",
      inputSchema: { path: z.string().describe('Absolute path to the sound file') },
    },
    tool('import_media', async (w, { path }: { path: string }) => text(await w.importMedia(path))),
  );

  server.registerTool(
    'render_frame',
    {
      title: 'Render a frame',
      description: 'Renders one frame so you can see it. Writes the full-size PNG to out/<scene>/ (out/<project>/<scene>/ in a project) and returns a preview at most maxWidth wide.',
      inputSchema: { sceneId, frame, maxWidth: z.number().int().min(64).max(3840).default(1280).describe('Preview width limit in pixels') },
      annotations: { readOnlyHint: true },
    },
    tool('render_frame', async (w, { sceneId: id, frame: f, maxWidth }: { sceneId: string; frame: number | string; maxWidth: number }) => {
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
    tool('render_contact_sheet', async (w, args: { sceneId: string; from?: number | string; to?: number | string; every?: number; columns?: number }) => {
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
    tool('hit_test', async (w, { sceneId: id, frame: f, x, y }: { sceneId: string; frame: number | string; x: number; y: number }) =>
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
      'apply_to_selection',
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
        "Exports a scene. mp4 is H.264 at the scene fps, gif loops, and html is a single self-contained file that draws the scene live with no network requests. mp4 and html carry the scene's audio unless silent is true; gif is always silent. html leaves sound file cues out (and says which in mediaLeftOut) unless media is true, which inlines the files and makes the export as big as its sound. mp4 and gif take an optional [from, to) range; html is always the whole scene. Returns the output path.",
      inputSchema: {
        sceneId,
        target: z.enum(['mp4', 'gif', 'html']),
        from: frame.optional(),
        to: frame.optional(),
        silent: z.boolean().optional().describe("Leave the scene's audio out of an mp4 or html export."),
        media: z.boolean().optional().describe('For html: inline the sound files its cues play.'),
      },
    },
    tool(
      'export',
      async (
        w,
        { sceneId: id, target, from, to, silent, media }: { sceneId: string; target: 'mp4' | 'gif' | 'html'; from?: number | string; to?: number | string; silent?: boolean; media?: boolean },
      ) => text(await w.export(id, target, { from, to, silent, media })),
    ),
  );

  if (!options.requests) return;
  const { selections } = options.requests;

  // ---- The viewer's request queue (ADR 0003, ADR 0006) ----

  const noneWaiting =
    'No Frame Studio request is waiting for an external agent. Send one from the viewer: select something, write a prompt, pick External agent, and press Send.';

  server.registerTool(
    'next_request',
    {
      title: 'Take the next request',
      description:
        "Claims the oldest request waiting for an agent in the viewer's queue and returns it. A request is a thread: the user asks, you work one turn and complete it, and the user may reply, which puts the request back in the queue as the next turn. You get the whole thread, then the ask for this turn: the prompt, the selection (scene, layer, part, frame range), the frame on screen, where the user clicked, and reference image paths. The scene is saved first so the user can revert your turn. Call complete_request when you finish the turn.",
    },
    tool('next_request', async (w) => {
      const request = await w.nextRequest(hooks?.session);
      return text(request ? `${await w.describeRequest(request)}\n\n${JSON.stringify(request, null, 2)}` : noneWaiting);
    }),
  );

  server.registerTool(
    'get_request',
    {
      title: 'Get a request',
      description:
        'A request from the viewer by id, as in a line the user pasted ("Frame Studio request #7 ..."), with its whole thread. If its newest turn is waiting for an agent, this claims it for you and saves the scene first, so the user can revert. Call complete_request when you finish the turn.',
      inputSchema: { id: z.number().int().min(1).describe('The request number') },
    },
    tool('get_request', async (w, { id }: { id: number }) => {
      const request = await w.getRequest(id, hooks?.session);
      return text(`${await w.describeRequest(request)}\n\n${JSON.stringify(request, null, 2)}`);
    }),
  );

  server.registerTool(
    'complete_request',
    {
      title: 'Complete a request',
      description:
        'Ends your turn on a request as done or failed, with a one-line summary the user sees in the viewer, e.g. "set pip\'s expression to sad over frames 24 to 48". The thread stays open: the user may reply, which comes back as the next turn, or settle it.',
      inputSchema: {
        id: z.number().int().min(1),
        status: z.enum(['done', 'failed']),
        summary: z.string().min(1).describe('One line: what you changed, or why it failed'),
      },
    },
    tool('complete_request', async (w, { id, status, summary }: { id: number; status: 'done' | 'failed'; summary: string }) => text(await w.completeRequest(id, status, summary))),
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
      description: "Takes the oldest request waiting for an agent in the viewer's queue and starts on its turn.",
    },
    () =>
      serial(async () => {
        try {
          const w = await ws();
          const request = await w.nextRequest(hooks?.session);
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
}
