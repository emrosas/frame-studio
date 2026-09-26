# The MCP server

Frame Studio's MCP server is the coding agent's API to the studio. It lists and edits scenes, shows the agent rendered frames, finds what is under a pixel, writes scoped edits, and exports. It runs on your machine over stdio, next to your agent.

## Setup

Once per checkout:

```sh
npm install
npx playwright install chromium-headless-shell   # the headless browser that renders frames
```

### Claude Code

The repo's `.mcp.json` registers the server for this project, so Claude Code offers to enable `frame-studio` the first time you start it in the repo root. Approve it, then check with `/mcp`.

To register it yourself instead, for example to use it from another folder:

```sh
claude mcp add frame-studio -- node /absolute/path/to/animation-tool/tools/mcp/server.ts
```

### Other agents

Any MCP client that can start a stdio server can use it. The command is `node`, with the argument `tools/mcp/server.ts`, run from the repo root, or with an absolute path to that file from anywhere. It needs Node 26 or later, which runs the TypeScript directly.

## Tools

Frames are a frame number or an `MM:SS:FF` timecode, where `FF` is the frame within the second. Ranges are `[from, to)`: `from` is included and `to` is not. Scene ids are the ones `list_scenes` shows: a loose scene's id, or `<project>/<scene>` for a scene in a project, such as `bears-story/film` (`docs/SCENES.md`, "Projects").

| Tool | What it does |
| --- | --- |
| `list_scenes()` | Every scene, loose ones first: id, project, file, fps, duration, frame count, size, layers (with the rig, cast member or placed scene each draws) and any validation errors. |
| `get_scene(id)` | The scene JSON exactly as it is in its file. |
| `update_scene(id, patch)` | Applies an RFC 7386 JSON merge patch. Objects merge, `null` deletes a key, and arrays are replaced whole. The result is validated first, and nothing is saved when it is invalid. In a project, it also refuses an edit that would break a scene placing this one, such as shortening a shot below its trim. |
| `list_rigs()` | Each rig's param schema, the parts it declares, its variants and, for a variant, its base. A project's own rig carries `project`, and only that project's scenes can use it. |
| `list_projects()` | Every project: name, fps, size, main scene, cast, its scenes by qualified id, its own rigs, and any errors in `project.json`. |
| `get_project(id)` | The project's `project.json` exactly as it is in its file. |
| `update_project(id, patch)` | A merge patch to `project.json`, such as a cast change. The result must be a valid project, and every scene in the project must stay valid under it. It changes every scene in the project, so it waits while another request in the project is working, for up to about 50 s, and then refuses. Because every scene must match the project's `fps` and `size`, changing either means editing `project.json` and every scene file by hand. |
| `list_generators()` | Each audio generator's param schema, for the scene's `audio` cues. |
| `render_frame(sceneId, frame, maxWidth?)` | Writes the full-size PNG to `out/<scene>/` (`out/<project>/<scene>/` in a project) and returns a preview up to `maxWidth` wide (1280 by default). |
| `render_contact_sheet(sceneId, from?, to?, every?, columns?)` | A labelled grid of every Nth frame, returned as an image and written to `out/<scene>/`. |
| `hit_test(sceneId, frame, x, y)` | The layer and part at a scene pixel, and every layer with paint there. On a shot a scene places, it names the scene layer; hit-test the shot itself to find what's inside. |
| `apply_to_selection(selection, patch)` | A scoped edit. Over `[from, to)` of one layer, it swaps to a rig variant and/or holds params, written as overrides. |
| `export(sceneId, target, from?, to?, silent?)` | `mp4`, `gif` or `html`. MP4 and HTML carry the scene's audio unless `silent` is true; GIF never does. Returns the file path under `out/`. |
| `next_request()` | Claims the oldest request waiting for an external agent and returns the whole thread, with instructions for this turn. |
| `get_request(id)` | A request by id, as in a pasted line, with its thread. A turn that is still waiting gets claimed, so its checkpoint is taken. |
| `complete_request(id, status, summary)` | Ends your turn as `done` or `failed`, with a one-line summary the viewer shows. The thread stays open for the user to reply or settle. |
| `get_selection()` | What is selected in the viewer right now: scene, layer, part, range, frame, and click point. |

In Claude Code the server also offers the `/frame-studio:next` command, which takes the next request and hands it to the agent, and the resource `@frame-studio:selection://current`, the viewer's current selection.

A selection is `{ sceneId, layerId?, partId?, from, to }`. `layerId` comes from `hit_test`, and `"background"` means the background. Leaving out `layerId` selects the whole frame range, and then params go to every layer whose rig takes all of them. A rig swap always needs a layer. A patch is `{ rig?, params? }`. An override the range only partly covers is split, so it keeps applying outside the range and the patch lands on top of it inside. A `partId` is accepted, but params apply to the whole layer. A part-level change needs a rig variant.

## Requests from the viewer

The viewer's Requests panel, on the left, sends asks to an agent through files in `.frame-studio/` (`docs/adr/0003-selection-handoff-file-queue.md`, `docs/adr/0006-requests-are-threads.md`). You select something on the canvas, write what should change, attach reference images if you like, pick who works it, and press **Send to agent**.

A request is a thread, like a chat. The agent works a turn and ends it with a summary; you look, and reply ("a bit smaller") or **Settle** it when it's right. Only you settle a thread, and replying to a settled one reopens it. Each turn saves the scene file before the agent starts, so **Revert to here** on any turn puts the scene back to how it was before that turn. **Try again** reverts the newest turn and asks again, with the prompt editable. Reverting is offered only when no other request on that scene was active after the save, so it can never throw away someone else's work. One thread per scene works at a time; threads on other scenes run in parallel.

### The external agent

Pick **External agent** and the request waits for any MCP agent, such as Claude Code in a terminal. A line to paste goes to the clipboard: `Frame Studio request #7: "..." ... get_request (id 7) ...`. In Claude Code, `/frame-studio:next` does the same without pasting. When you reply, the thread goes back into the queue, and the next `next_request` or `get_request` returns it with every turn so far.

### Agents in the studio

Pick **Claude** or **Codex** and the studio runs the agent itself, on your machine, through the CLI you already have installed and signed in: `claude`, through Anthropic's Agent SDK, or `codex app-server`. The studio never shows a login screen and never sees a token. An API key in your environment works through either CLI. If a CLI is missing or signed out, the picker says so and shows the command that fixes it (`claude auth login`, `codex login`).

The thread streams what the agent does: its reply, one line per step, and thumbnails of the frames it rendered, which you can click to see on the canvas. Each thread has its own model, effort and access, and you can change them between turns.

- **Access.** By default the agent uses the studio's tools (the same operations as this MCP server) on its own scene, reads the repo, and writes in `scenes/`, `src/rigs/`, `src/audio/` and any project's `rigs/`. Another scene's file, like another scene through the tools, asks first. So does anything else, such as another file, a shell command or the network: an approval card shows in the thread. **Full access** turns the cards off. Either way, a scene another request is working on is off limits, and editing a rig that scene draws with asks first.
- **Projects.** An edit to a project's `project.json`, through `update_project` or to the file, touches every scene in the project. It waits until no other request in the project is working, for up to about 50 s, and then gives up with the reason, so two threads never change a project under each other. A turn on a project scene also saves `project.json`, and **Revert to here** on a turn that changed it restores both files. It's offered only when nothing else in the project is working and no other request has changed `project.json` since. Rig code stays with git.
- **Stop** ends the agent's turn and keeps what it changed so far. If the dev server stops mid-turn, the turn shows as interrupted, and your next reply resumes the agent's session.
- Claude gets the studio tools in the studio server's own process. Codex reaches them at `/__studio/mcp` on the dev server, with a token per turn passed in its environment. Transcripts and thumbnails live next to the request in `.frame-studio/requests/`.
- The access rules keep a well-meaning agent inside the lines; they are not a sandbox. Rig and generator code an agent writes runs in the studio server and the browser.
- The studio server answers only this computer, even when Vite listens on the network. Programs on this computer are trusted, as they are by any dev server.

## A typical loop

1. `list_scenes`, then `render_frame` to see where things stand. In a project, `list_projects` shows the cast and which scene is the main one.
2. `hit_test` on the thing to change, to get its layer.
3. `apply_to_selection` for a change over some frames, or `update_scene` for a change to the whole scene. Sound is `update_scene` on the scene's `audio` cues, with generators from `list_generators`. The agent can't hear it, so place cues by frame: a cue starts on the frame its `start` falls in.
4. `render_frame` or `render_contact_sheet` again to check it. Frames outside the edited range are untouched.
5. `export` when it looks right.

## Notes

- The first tool that renders starts Vite and a headless Chromium, which takes about 3 seconds. Later calls reuse them.
- Tools run one at a time, even when the agent calls several at once, because they share one page and the scene files.
- Writes go through the scene validator first, and scene files are written in the studio's format: two-space indents, with short objects and arrays on one line.
- The server watches `src/`, `scenes/` and `projects/`. Edits the agent makes to those files directly, without the tools, show up in the next render.
- Renders and exports go to `out/`, which git ignores.
- The viewer's studio server (`/__studio/` on the dev server) takes requests only from the viewer's own page. It refuses other sites, takes JSON only, and checks every request. Reference paths must be images directly in `references/`.
- `FRAME_STUDIO_DIR` moves the handoff folder. The tests use it, so they never touch a real queue.
