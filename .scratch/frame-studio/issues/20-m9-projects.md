# M9: Projects

Type: task
Status: resolved
Blocked by: 17

## Work

Build milestone M9 as written in `docs/ROADMAP.md`, as ticket 17 settled it (`docs/adr/0007-projects-and-scene-layers.md`): project folders with `project.json`, qualified scene ids, scene layers, masks, a cast, project rigs, audio through scene layers, the viewer's project picker, shot bands and Open shot, the agents' project rules, and the MCP project tools. Include the sample `projects/bears-story/`.

## Outcome

Built on 2026-09-25, and the nine acceptance criteria pass. `docs/PROGRESS.md`, "M9: Projects", has the detail.

- **Engine:** scene layers that draw a shot pixel for pixel as it draws alone, masks, the cast, and project checks for loops, depth, fps and size. Opacity and masks composite on surfaces each host passes in.
- **Sound:** each shot's audio renders once and is cut into its parent sample for sample. Cues can take volume keys.
- **Viewer:** the grouped picker, shot bands, Open shot and the link back.
- **Agents and MCP:** project rigs are writable, `project.json` edits wait for the project's other threads, and turns checkpoint `project.json`. `list_projects`, `get_project` and `update_project` are new.
- **Sample:** `projects/bears-story/`, three shots and a film with a cut, a crossfade and an iris from a project rig.
- **Reviews:** two agents reviewed M9. Their fixes include clipping moved shots to their stage, re-checking the scenes that place a shot when it's edited, and a band double-click that survives the controls reflowing.
