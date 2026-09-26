// The packaged app's MCP server for external agents (ADR 0008), bundled as
// Resources/server/shim.mjs and run by Resources/bin/frame-studio-mcp on the
// app's own binary in Node mode. It finds the app's server for the folder, or
// starts a headless one from the app's built files.

import { join } from 'node:path';
import { installLoader } from '../studio/loader.ts';

const resources = join(import.meta.dirname, '..');
const builtins = join(resources, 'builtins');
installLoader(builtins);
// A headless server's render worker is this app, in worker-only mode.
process.env.FRAME_STUDIO_ELECTRON ??= join(resources, '..', 'MacOS', 'Frame Studio');
const { runShim } = await import('../mcp/shim.ts');
await runShim({ viewer: { kind: 'static', dir: join(resources, 'viewer') }, builtins });
