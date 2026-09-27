# Frame Studio

Animations drawn entirely in code, made with a coding agent. You click what you see on the canvas, say what should change, and the agent edits the scene and the drawing code. A scene exports as an MP4, a GIF, or one HTML file with no dependencies.

Frame Studio is early. The app runs on Apple Silicon Macs only, and it isn't signed yet, so the first launch takes one extra step (see [Install the app](#install-the-app)).

## What it is

JavaScript draws every frame onto an HTML canvas. A scene has no images, video or fonts in it, and its sound is synthesized too. The scene itself is a JSON file of layers, keyframes and sound cues. Characters and objects are rigs, TypeScript functions that draw a thing from its params, such as a bear's pose, expression and position.

In Rive or Lottie, a person draws the artwork in an editor and a runtime plays it back. In Frame Studio the drawing code is the artwork, and an agent writes most of it. Through an MCP server on your machine, the agent can render any frame to look at its work, find which layer is under a pixel, edit scenes and rigs, and export.

One scene exports three ways:

- MP4, frame-exact at the scene's frame rate, with sound.
- GIF.
- A single HTML file holding the engine, only the rigs the scene uses, and the scene. It makes no network requests, so it works opened from disk, pasted into a web page, or in an iframe. The two-bear test scene comes to about 54 KB.

Rendering is deterministic. Frame N depends only on the scene and N, so scrubbing, playing, exporting and the embed all show the same pixels.

The idea comes from Kevin Ngo's pieces ([kengoworks.com](https://kengoworks.com)), single HTML files that compute every frame on a canvas.

## Install the app

You need a Mac with Apple Silicon (M1 or later) on macOS 13 or later. There are no Intel, Windows or Linux builds yet.

1. Download `Frame-Studio-<version>-arm64.dmg` from the [latest release](https://github.com/emrosas/frame-studio/releases/latest).
2. Open the DMG and drag Frame Studio into Applications. Run it from Applications, not from the DMG. The app updates itself in place and can't do that from a read-only disk.
3. Open Frame Studio from Applications. The first time, macOS stops it with "Apple could not verify 'Frame Studio' is free of malware", because the app isn't signed with an Apple Developer ID yet. Click Done, not Move to Trash.
4. Open System Settings › Privacy & Security and scroll down to Security. Click Open Anyway next to the message about Frame Studio, and confirm. The button shows for about an hour after the blocked launch, so if it's gone, open the app again first.

   If you'd rather use Terminal, this clears the download flag, and the app then opens normally:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Frame Studio.app"
   ```

You only do this once. Updates install without it.

### Updates

The app checks GitHub Releases 10 seconds after it starts and every 4 hours after that. When there's a new version, a card at the foot of the sidebar offers Update. One click downloads it, checks its SHA-512 against the release, replaces the app and restarts it. Frame Studio › Check for Updates… checks right away.

## Getting started

The first launch offers New studio folder and Open folder. A studio folder holds your work:

```
scenes/       loose scenes, one JSON file each
projects/     projects, whose scenes share a size and frame rate and can place each other as shots
rigs/         your own rigs
audio/        your own sound generators
references/   reference images for the agent, never exported
out/          renders and exports
```

New studio folder creates `~/Frame Studio` with two samples. `hello` is a bouncing ball, and `bears-story` is a 12-second film cut from three shots.

The window has three columns. The sidebar lists scenes and request threads. The middle has the canvas and the timeline. Space plays, the arrow keys step one frame, and the keyboard button in the top bar lists the other shortcuts. The agent panel is on the right.

To ask for a change:

1. Click something on the canvas to select its layer. Alt-click selects a part of it, such as a character's nose.
2. If the change is for some frames only, press I on the first frame and O on the last.
3. Describe the change in the agent panel, attach reference images if you have them, and send.

Each request is a thread. The agent works a turn and reports back. Reply to adjust it ("a bit smaller"), use Revert to here to undo a turn, and Settle the thread when it's right.

Export in the top bar writes an MP4, GIF or HTML file of the scene, or of the selected frames, to `out/`.

## Connect an agent

Frame Studio has no model of its own and no sign-in. It uses the agent CLIs already on your machine, with your accounts.

### Inside the app

Pick Claude or Codex in the agent panel. The studio runs the CLI for you, so it needs one of these installed and signed in:

- [Claude Code](https://claude.com/claude-code), which provides `claude`. Sign in with `claude auth login`.
- The [Codex CLI](https://github.com/openai/codex), which provides `codex`. Sign in with `codex login`.

If a CLI is missing or signed out, the agent picker says so and shows the command to run.

By default the agent can edit scenes, rigs and sound generators in the studio folder. For anything else, such as another file or a shell command, it asks first with an approval card in the thread. Full access in the composer turns the cards off.

### Your own agent, over MCP

Any MCP client can drive the studio: list and edit scenes, render frames and contact sheets, hit-test pixels, export, and take the requests you send from the viewer. For Claude Code, run this in your studio folder:

```sh
claude mcp add frame-studio -- "/Applications/Frame Studio.app/Contents/Resources/bin/frame-studio-mcp"
```

Start Claude Code in that folder and check the connection with `/mcp`. To hand it a request, pick External agent in the viewer, send, and run `/frame-studio:next` in Claude Code. The MCP server also works with the app closed. It starts a headless studio for the session.

[docs/MCP.md](docs/MCP.md) lists every tool.

## Run from source

Development happens on macOS with Apple Silicon. Other platforms are untested. You need Node 26 or later, since the tools run TypeScript through Node's own type stripping.

```sh
git clone https://github.com/emrosas/frame-studio.git
cd frame-studio
npm install
npm run dev        # the studio server on the repo; open the URL it prints
npm run desktop    # the app, from source
```

The repo is a studio folder itself. Its scenes are in `scenes/` and `projects/`, and the built-in rigs are in `src/rigs/`. Its `.mcp.json` registers the MCP server, so Claude Code started in the repo root offers to enable it.

Render from the command line:

```sh
npm run render -- --scene bear-test --frame 47          # PNG
npm run export -- --scene bear-test --target mp4        # or gif, html
npm run contact-sheet -- --scene bear-test --every 6
```

Test:

```sh
npm run typecheck
npm test                                          # unit tests
npx playwright install chromium-headless-shell    # once, for the browser tests
npm run test:browser                              # viewer, renders, exports, embed, app
```

`npm run desktop:build` packages the app and its DMG into `build/desktop/dist/`. [docs/RELEASING.md](docs/RELEASING.md) covers publishing a release.

## Documentation

- [docs/SCENES.md](docs/SCENES.md) has the scene format, the built-in rigs and generators, projects, how to write a rig or a generator, and rendering and export.
- [docs/MCP.md](docs/MCP.md) has MCP setup, every tool, and how requests flow between the viewer and an agent.
- [docs/ROADMAP.md](docs/ROADMAP.md) has the milestones, and [docs/PROGRESS.md](docs/PROGRESS.md) has what's done, what's next and the known issues.
- [docs/adr/](docs/adr/) has the architecture decisions.
- [docs/RELEASING.md](docs/RELEASING.md) explains how to cut a release.

## Known limits

- The app is macOS on Apple Silicon only. It has no Apple Developer ID signature or notarization, so macOS blocks the first launch until you allow it.
- Nothing proves who built an update beyond HTTPS to GitHub and a checksum published on the same release. Each update downloads the whole app, about 124 MB.
- There's no timeline editor yet. Timing lives in the scene JSON, which you or the agent edit.
- Agent access rules keep a well-behaved agent on track, but they aren't a sandbox. Rig code an agent writes runs in the studio server and the viewer.

## License

MIT. See [LICENSE](LICENSE).
