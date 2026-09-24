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

Frames are a frame number or an `MM:SS:FF` timecode, where `FF` is the frame within the second. Ranges are `[from, to)`: `from` is included and `to` is not. Scene ids are the ones `list_scenes` shows.

| Tool | What it does |
| --- | --- |
| `list_scenes()` | Every scene: id, file, fps, duration, frame count, size, layers and any validation errors. |
| `get_scene(id)` | The scene JSON exactly as it is in its file. |
| `update_scene(id, patch)` | Applies an RFC 7386 JSON merge patch. Objects merge, `null` deletes a key, and arrays are replaced whole. The result is validated first, and nothing is saved when it is invalid. |
| `list_rigs()` | Each rig's param schema, the parts it declares, its variants and, for a variant, its base. |
| `render_frame(sceneId, frame, maxWidth?)` | Writes the full-size PNG to `out/<scene>/` and returns a preview up to `maxWidth` wide (1280 by default). |
| `render_contact_sheet(sceneId, from?, to?, every?, columns?)` | A labelled grid of every Nth frame, returned as an image and written to `out/<scene>/`. |
| `hit_test(sceneId, frame, x, y)` | The layer and part at a scene pixel, and every layer with paint there. |
| `apply_to_selection(selection, patch)` | A scoped edit. Over `[from, to)` of one layer, it swaps to a rig variant and/or holds params, written as overrides. |
| `export(sceneId, target, from?, to?)` | `mp4`, `gif` or `html`. Returns the file path under `out/`. |

A selection is `{ sceneId, layerId?, partId?, from, to }`. `layerId` comes from `hit_test`, and `"background"` means the background. Leaving out `layerId` selects the whole frame range, and then params go to every layer whose rig takes all of them. A rig swap always needs a layer. A patch is `{ rig?, params? }`. An override the range only partly covers is split, so it keeps applying outside the range and the patch lands on top of it inside. A `partId` is accepted, but params apply to the whole layer. A part-level change needs a rig variant.

## A typical loop

1. `list_scenes`, then `render_frame` to see where things stand.
2. `hit_test` on the thing to change, to get its layer.
3. `apply_to_selection` for a change over some frames, or `update_scene` for a change to the whole scene.
4. `render_frame` or `render_contact_sheet` again to check it. Frames outside the edited range are untouched.
5. `export` when it looks right.

## Notes

- The first tool that renders starts Vite and a headless Chromium, which takes about 3 seconds. Later calls reuse them.
- Tools run one at a time, even when the agent calls several at once, because they share one page and the scene files.
- Writes go through the scene validator first, and scene files are written in the studio's format: two-space indents, with short objects and arrays on one line.
- The server watches `src/` and `scenes/`. Edits the agent makes to those files directly, without the tools, show up in the next render.
- Renders and exports go to `out/`, which git ignores.
