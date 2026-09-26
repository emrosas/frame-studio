// Chromium switches every Frame Studio window renders with: CPU canvas raster
// and no runtime-chosen Skia paths, so a frame's pixels repeat run to run
// (ticket 03), and an sRGB profile. The app, the worker and the tests' windows
// all use them, so their pixels match. Electron main process only.

import type { App } from 'electron';

export function applyRenderSwitches(app: App): void {
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-skia-runtime-opts');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
}
