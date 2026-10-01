# The MCP server

Frame Studio's MCP server is the coding agent's API to the studio. It lists and edits scenes, shows the agent rendered frames, finds what is under a pixel, writes scoped edits, and exports. It runs on your machine over stdio, next to your agent, and works on a studio folder: the one the agent starts it in, or `--folder <path>`.

It's a small shim (ADR 0008). When the app, or `npm run dev`, has the folder open, the shim forwards every call to that studio server, so the agent's renders come from the same render worker as your viewer, and its request threads are yours. Otherwise it starts a headless studio server of its own for the session, with a render worker in Electron, and stops it when the agent disconnects.

## Setup

### With the app

The app ships the command as `Frame Studio.app/Contents/Resources/bin/frame-studio-mcp`. In a terminal in your studio folder, register it with Claude Code:

```sh
claude mcp add frame-studio -- "/Applications/Frame Studio.app/Contents/Resources/bin/frame-studio-mcp"
```

Start Claude Code in the folder, and check with `/mcp`.

### From the repo

Once per checkout, `npm install`. It brings Electron, which renders the frames.

The repo's `.mcp.json` registers the shim for this project, so Claude Code offers to enable `frame-studio` the first time you start it in the repo root. Approve it, then check with `/mcp`. To register it yourself instead, for example for a studio folder elsewhere:

```sh
claude mcp add frame-studio -- node /absolute/path/to/animation-tool/tools/mcp/server.ts --folder /path/to/studio-folder
```

### Other agents

Any MCP client that can start a stdio server can use it: `frame-studio-mcp` from the app, or `node tools/mcp/server.ts` from the repo, which needs Node 26 or later to run the TypeScript directly.

## Tools

Frames are a frame number or an `MM:SS:FF` timecode, where `FF` is the frame within the second. Ranges are `[from, to)`: `from` is included and `to` is not. Scene ids are the ones `list_scenes` shows: a scene's or a composition's id, which share one namespace, or `<project>/<scene>` for a scene in a film made before compositions, such as `bears-story/film` (`docs/SCENES.md`, "Projects and compositions").

| Tool | What it does |
| --- | --- |
| `list_scenes()` | Every scene and composition, then the old films' scenes: id, `kind` (`scene` or `composition`), project, file, fps, duration, frame count, size, layers (with the rig, cast member or placed scene each draws; a composition's clips are its layers) and any validation errors. |
| `get_scene(id)` | The scene or composition JSON exactly as it is in its file. |
| `update_scene(id, patch)` | Applies an RFC 7386 JSON merge patch to a scene or a composition. Objects merge, `null` deletes a key, and arrays are replaced whole, so changing one clip means sending the whole `tracks` array. The result is validated first, and nothing is saved when it is invalid. It also refuses an edit that would break a composition placing this one, such as shortening a scene below a clip's trim or changing its fps. |
| `create_scene(id, fps?, size?, duration)` | A new, empty scene in `scenes/<id>.json`: a paper background and no layers, to fill with `update_scene`. Without `fps` and `size` it takes `project.json`'s, or 24 fps at 1920×1080. The id is lowercase letters, digits and single hyphens, and an id a scene or composition has is refused. |
| `create_composition(id, fps?, size?, duration)` | A new composition in `compositions/<id>.json`, with one empty track, `V1`, and a black background. Format as for `create_scene`. Add clips with `update_scene` on its `tracks`. |
| `list_rigs()` | Each rig's param schema, the parts it declares, its variants and, for a variant, its base. A project's own rig carries `project`, and only that project's scenes can use it. |
| `get_project(id?)` | With no id, the folder's `project.json` (ADR 0013): its name, the format new scenes and compositions start with, and its cast, or `{}` when it has none. With an id, an old film's `project.json`. |
| `update_project(id?, patch)` | A merge patch to `project.json`, such as a cast change. With no id, the folder's: every scene and composition must stay valid under it. With an id, an old film's: every scene in it must stay valid, and it waits while another request in the film is working, for up to about 50 s, and then refuses. |
| `list_projects()` | The films made before compositions, in `projects/<id>/` (ADR 0007): name, fps, size, main scene, cast, scenes by qualified id, own rigs, and any errors. The viewer can convert each into a project folder of its own. |
| `list_media()` | The sound files in `media/` (ADR 0012), each with its path for a cue, size and, from its header, duration in seconds, channels and sample rate. A cue plays one with `{ "id", "file", "start", "end", "in"?, "fadeIn"?, "fadeOut"?, "tracks"? }`; `docs/SCENES.md`, "Sound files". |
| `import_media(path)` | Copies a sound file from a path on this computer into `media/`, named after it and numbered if taken, and returns its path and duration. Agents in the studio ask first for a file outside the studio folder. |
| `list_generators()` | Each audio generator's param schema, for the scene's `audio` cues. |
| `render_frame(sceneId, frame, maxWidth?)` | Writes the full-size PNG to `out/<scene>/` (`out/<project>/<scene>/` in an old film) and returns a preview up to `maxWidth` wide (1280 by default). |
| `render_contact_sheet(sceneId, from?, to?, every?, columns?)` | A labelled grid of every Nth frame, returned as an image and written to `out/<scene>/`. |
| `hit_test(sceneId, frame, x, y)` | The layer and part at a scene pixel, and every layer with paint there. On a composition, it names the clip; hit-test the clip's scene to find what's inside. |
| `apply_to_selection(selection, patch)` | A scoped edit. Over `[from, to)` of one layer, it swaps to a rig variant and/or holds params, written as overrides. |
| `export(sceneId, target, from?, to?, silent?, media?)` | `mp4`, `gif` or `html`. MP4 and HTML carry the scene's audio unless `silent` is true; GIF never does. HTML leaves sound files out, and lists them in `mediaLeftOut`, unless `media` is true. Returns the file path under `out/`. |
| `next_request()` | Claims the oldest request waiting for an external agent and returns the whole thread, with instructions for this turn. |
| `get_request(id)` | A request by id, as in a pasted line, with its thread. A turn that is still waiting gets claimed, so its checkpoint is taken. |
| `complete_request(id, status, summary)` | Ends your turn as `done` or `failed`, with a one-line summary the viewer shows. The thread stays open for the user to reply or settle. |
| `get_selection()` | What is selected in the viewer right now: scene, layer, part, range, frame, and click point. |

In Claude Code the server also offers the `/frame-studio:next` command, which takes the next request and hands it to the agent, and the resource `@frame-studio:selection://current`, the viewer's current selection.

A selection is `{ sceneId, layerId?, partId?, from, to }`. `layerId` comes from `hit_test`, and `"background"` means the background. Leaving out `layerId` selects the whole frame range, and then params go to every layer whose rig takes all of them. A rig swap always needs a layer. A patch is `{ rig?, params? }`. An override the range only partly covers is split, so it keeps applying outside the range and the patch lands on top of it inside. A `partId` is accepted, but params apply to the whole layer. A part-level change needs a rig variant.

## Requests from the viewer

The viewer's agent panel, on the right, sends asks to an agent through files in `.frame-studio/` (`docs/adr/0003-selection-handoff-file-queue.md`, `docs/adr/0006-requests-are-threads.md`). You select something on the canvas, write what should change, attach reference images if you like, pick who works it, and send. The sidebar lists the threads.

A request is a thread, like a chat. The agent works a turn and ends it with a summary; you look, and reply ("a bit smaller") or **Settle** it when it's right. Only you settle a thread, and replying to a settled one reopens it. Each turn saves the scene file before the agent starts, so **Revert to here** on any turn puts the scene back to how it was before that turn. **Try again** reverts the newest turn and asks again, with the prompt editable. Reverting is offered only when no other request on that scene was active after the save, so it can never throw away someone else's work. One thread per scene works at a time; threads on other scenes run in parallel.

### The external agent

Pick **External agent** and the request waits for any MCP agent, such as Claude Code in a terminal. A line to paste goes to the clipboard: `Frame Studio request #7: "..." ... get_request (id 7) ...`. In Claude Code, `/frame-studio:next` does the same without pasting. When you reply, the thread goes back into the queue, and the next `next_request` or `get_request` returns it with every turn so far.

### Agents in the studio

Pick **Claude** or **Codex** and the studio runs the agent itself, on your machine, through the CLI you already have installed and signed in: `claude`, through Anthropic's Agent SDK, or `codex app-server`. The studio never shows a login screen and never sees a token. An API key in your environment works through either CLI. If a CLI is missing or signed out, the picker says so and shows the command that fixes it (`claude auth login`, `codex login`).

The thread streams what the agent does: its reply, one line per step, and thumbnails of the frames it rendered, which you can click to see on the canvas. Each thread has its own model, effort and access, and you can change them between turns.

- **Access.** By default the agent uses the studio's tools (the same operations as this MCP server) on its own scene, reads the studio folder, and writes in `scenes/`, `compositions/`, `rigs/`, `audio/`, `project.json`, an old film's `rigs/`, and in the repo `src/rigs/` and `src/audio/`. Another scene's or composition's file, like another scene through the tools, asks first. So does anything else, such as another file, a shell command or the network: an approval card shows in the thread. **Full access** turns the cards off. Either way, a scene another request is working on is off limits, and editing a rig that scene draws with asks first.
- **Old films.** An edit to a film's `project.json` in `projects/<id>/`, through `update_project` or to the file, touches every scene in the project. It waits until no other request in the project is working, for up to about 50 s, and then gives up with the reason, so two threads never change a project under each other. A turn on a project scene also saves `project.json`, and **Revert to here** on a turn that changed it restores both files. It's offered only when nothing else in the project is working and no other request has changed `project.json` since. Rig code stays with git.
- **Questions.** When a request leaves a choice that changes the result, such as a typeface or a layout, the agent asks with a card above the thread's actions (ADR 0011): up to four questions, each with a few options, the recommended one first. Click an option or press its number; a single choice moves on, and the last one sends. Type an answer of your own instead, or with the options where you can pick several. Skip lets the agent decide. The turn waits while the card is open, and Stop closes it. Claude asks with its own AskUserQuestion tool and Codex with request_user_input, which the studio switches on; it's experimental in Codex.
- **Stop** ends the agent's turn and keeps what it changed so far. If the studio server stops mid-turn (the app quits, say), the turn shows as interrupted, and your next reply resumes the agent's session.
- Claude gets the studio tools in the studio server's own process. Codex reaches them at `/__studio/mcp` on the studio server, with a token per turn passed in its environment. Transcripts and thumbnails live next to the request in `.frame-studio/requests/`.
- The access rules keep a well-meaning agent inside the lines; they are not a sandbox. Rig and generator code an agent writes runs in the studio server and the browser.
- The studio server listens on 127.0.0.1 only, and every caller pairs with it (see the notes below). Programs on this computer that can read your files are trusted, as they are by any dev server.

## A typical loop

1. `list_scenes`, then `render_frame` to see where things stand. For something new, `create_scene` or `create_composition` first. `get_project` shows the cast.
2. `hit_test` on the thing to change, to get its layer.
3. `apply_to_selection` for a change over some frames, or `update_scene` for a change to the whole scene. Sound is `update_scene` on the scene's `audio` cues, with generators from `list_generators`. The agent can't hear it, so place cues by frame: a cue starts on the frame its `start` falls in.
4. `render_frame` or `render_contact_sheet` again to check it. Frames outside the edited range are untouched.
5. `export` when it looks right.

## Notes

- Without an app or `npm run dev` open on the folder, the first tool call starts a studio server, and the first render starts Electron's render worker, a few seconds in all. Later calls reuse them.
- Tools run one at a time, even when the agent calls several at once, because they share one render worker and the scene files.
- Writes go through the scene validator first, and scene files are written in the studio's format: two-space indents, with short objects and arrays on one line.
- The server watches the studio folder's `project.json`, `scenes/`, `compositions/`, `projects/`, `rigs/`, `audio/` and `media/`, and in the repo `src/`. Edits the agent makes to those files directly, without the tools, show up in the next render, and in the open viewer without a reload.
- Renders and exports go to `out/`, which git ignores.
- The studio server answers only this computer, and only callers paired with it: the viewer, through a cookie it trades its pairing token for, and tools, with the token as a bearer token. It writes its address and token to `.frame-studio/server.json`, readable only by you, which is how the shim finds it. It refuses other sites, takes JSON only, and checks every request. Reference paths must be images directly in `references/`.
- `FRAME_STUDIO_DIR` moves the handoff folder. The tests use it, so they never touch a real queue.
