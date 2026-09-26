// Frame Studio's Electron main process (ADR 0008). Two modes:
//
// - The app: a studio folder, a studio server in a utility process, the viewer
//   in a window, a hidden render worker, and native menus. See app.ts.
// - Worker only (--worker): a hidden render worker window for a studio server
//   that runs without the app, such as the CLI's or the MCP shim's. The server
//   writes its address and token to stdin.
//
// Both render with the same switches, so pixels match between them (ticket 03).

import { app } from 'electron';
import { applyRenderSwitches } from './switches.ts';
import { runWorker } from './worker.ts';

applyRenderSwitches(app);

if (process.argv.includes('--worker')) {
  runWorker();
} else {
  const { runApp } = await import('./app.ts');
  runApp();
}
