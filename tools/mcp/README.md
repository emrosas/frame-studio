# MCP server

`server.ts` is Frame Studio's MCP server over stdio, and `workspace.ts` holds what each tool does, apart from the protocol. Setup and the tool reference are in `docs/MCP.md`. `tests/browser/mcp.test.ts` drives it through a real MCP client session.

One Vite server, watching `src/` and `scenes/`, serves both sides. In Node it loads the engine, the rigs and the viewer's scene library. For Playwright it serves `render.html`, which starts on the first tool that needs pixels. The page reloads whenever a watched file has changed since it last loaded. Scene writes are validated with the engine's validator, then written whole through a `.partial` file, using `formatSceneJson` from `src/engine/scene-edit.ts`.

stdout carries the protocol, so nothing may print to it. Like the other tools, the files run as TypeScript through Node's type stripping, and `tsconfig.node.json` sets `erasableSyntaxOnly` so the typecheck catches syntax Node can't strip.
