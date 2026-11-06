# 0013: A project is a folder; scenes draw and compositions arrange

Status: accepted, 2026-10-02, amended 2026-11-06 (projects in the sidebar, hand edits). Replaces ADR 0007's projects inside a studio folder, and ADR 0008's one folder per app window.

## Context

The viewer shows a whole studio folder at once: loose scenes, every project in `projects/`, one Media list and every thread. Inside a project any scene can place any other, so one scene can be a drawing, a cut of shots, or both. With sound files and a timeline editor coming, nothing says which scene is the edit, and a folder of several videos mixes on screen.

## Decision

- **A project is a folder,** as a codebase is in T3 Code. It holds everything the project uses: its scenes, its compositions, its own rigs and generators, its sound files, references, exports and threads. What its parts share sits at its top level, as a monorepo's shared packages do. Nothing is shared between projects but the built-ins.

  ```
  my-explainer/
    project.json     name, default fps and size, cast
    compositions/    the edits, one per video
    scenes/          drawn content
    rigs/  audio/    the project's own code
    media/           its sound files
    references/  out/  .frame-studio/
  ```

- **Many projects listed, one on screen.** The canvas shows one scene, so "open" means listed in the sidebar. Each recent project is a group there: a header with its name and a dot for its threads, then its videos, its scenes and any older films. The project on screen sits open at the top; the others stay folded until you open them. The + menu makes a new project and opens another folder. A browser shows the one group and can't switch.
- **The app lists a project without starting it.** It reads each recent project's videos, scenes, older films and posters from disk, as it reads its threads, so a project's server runs only when the project is on screen, an agent works there, or you've just left it. Clicking a row of another project loads that project's server in the window, on that scene.
- **Projects keep working in the background.** The app keeps a project's studio server, and its render worker, running after you switch away while a thread there is working or waiting for an agent. The two projects left most recently stay warm for ten minutes as well, so going back takes under a second; then the server stops. A project's header shows the most pressing of its threads: waiting on your input, your turn, or working, read from the project's own thread files.
- **What the viewer keeps belongs to the app.** Each project's server has its own port, so its page has its own storage. In the app, folds, layout, recent models and the agent picked live in the app's settings, and unsent prompts in the main process per project. A browser keeps them in its own storage.
- **Scenes draw, compositions arrange.** A scene has layers, rigs, keys, overrides and procedural sound, and never places anything. A composition arranges: tracks of clips, where a clip is a scene or another composition, sound files, and transitions between clips. Compositions nest as deep as you like; a loop is an error. A title over a cut is a small scene on an upper track. This takes the place of scene layers, which let any scene place scenes.
- **A composition has its own format.** Its size and fps default to the project's. A clip may be another size, since placement scales and positions it, but has the composition's fps.
- **A project's loose scenes** are its `scenes/`: a place to sketch without a composition.
- **Converting.** A folder made before this opens as a project: its scenes are the project's. Each `projects/<id>/` in it can become a project folder of its own on request, with its main scene turned into a composition and its shots into scenes. Nothing is rewritten without the user's say.

## Consequences

- The app runs a studio server per open project rather than one. Background projects cost a server and a hidden render window each, so at most two stay warm, for ten minutes, past any that agents are using.
- Projects can't share a rig or a sound file except by copying, until a shared library is worth having.
- The timeline editor (M15) edits compositions, and the canvas stays the way to edit scenes, so each screen has one job. ADR 0015 adds a scene's key times to the timeline.
- Agents work in one project, as threads always did; an agent in another project keeps going while you look elsewhere.
- A window can't show one project's page with another's data, so a switch is one page load. The window's background matches the page, and the stage shows "Opening <name>" until the new page draws.
- The order of work: the switcher and background projects first (M13; the switcher gave way to the sidebar's groups), then the project format and compositions with the conversion (M14), the timeline editor (M15) and stills (M16).
