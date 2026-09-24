# Bundle tools

`embed.ts` builds the single-file HTML embed (M4). `npm run export -- --scene <id> --target html` calls it, and `tests/browser/embed.test.ts` checks its output.

It starts Vite in middleware mode to load the engine, the rigs and the viewer's scene library in Node. It resolves the scene key with the viewer's own `buildLibrary` and `findEntry`, and validates the scene. Then it finds, for every rig id the scene uses, the module under `src/rigs` that exports it by name. The generated entry imports only those rigs and the player from `src/embed/player.ts`, and Vite bundles it into one minified script inlined into the page.

A transform plugin empties rig and param description text in the rig modules, working on the syntax tree from Vite's `parseAst`. The player never reads that text, and dropping it saves about 12%.

The scene goes in as `JSON.parse` of a string with every `<` escaped, so no scene text can close the inline `<script>`. Any `<!--` or `<script` left in the bundled code stops the build.

Like `tools/render`, the files run as TypeScript through Node's type stripping.
