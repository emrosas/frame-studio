# 0013: A project is a folder; scenes draw and compositions arrange

Status: accepted, 2026-10-02. Replaces ADR 0007's projects inside a studio folder, and ADR 0008's one folder per app window.

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

- **One project on screen.** A switcher at the top left of the window lists recent projects, opens another folder, and makes a new one. Everything on screen belongs to the open project.
- **Projects keep working in the background.** The app keeps a project's studio server, and its render worker, running after you switch away while a thread there is working or waiting for an agent, and stops it once none is. The switcher shows each project's working threads, threads waiting on your input, and threads that are your turn, read from the project's own thread files.
- **Scenes draw, compositions arrange.** A scene has layers, rigs, keys, overrides and procedural sound, and never places anything. A composition arranges: tracks of clips, where a clip is a scene or another composition, sound files, and transitions between clips. Compositions nest as deep as you like; a loop is an error. A title over a cut is a small scene on an upper track. This takes the place of scene layers, which let any scene place scenes.
- **A composition has its own format.** Its size and fps default to the project's. A clip may be another size, since placement scales and positions it, but has the composition's fps.
- **A project's loose scenes** are its `scenes/`: a place to sketch without a composition.
- **Converting.** A folder made before this opens as a project: its scenes are the project's. Each `projects/<id>/` in it can become a project folder of its own on request, with its main scene turned into a composition and its shots into scenes. Nothing is rewritten without the user's say.

## Consequences

- The app runs a studio server per open project rather than one. Background projects cost a server and a hidden render window each, so the app stops a project's server as soon as nothing runs there.
- Projects can't share a rig or a sound file except by copying, until a shared library is worth having.
- The timeline editor (M15) edits compositions only, and the canvas stays the way to edit scenes, so each screen has one job.
- Agents work in one project, as threads always did; an agent in another project keeps going while you look elsewhere.
- The order of work: the switcher and background projects first (M13), then the project format and compositions with the conversion (M14), the timeline editor (M15) and stills (M16).
