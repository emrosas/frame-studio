// Chromium switches every Frame Studio window renders with: CPU canvas raster
// and no runtime-chosen Skia paths, so a frame's pixels repeat run to run
// (ticket 03), an sRGB profile, and the HTML-in-Canvas feature html layers
// draw with (ADR 0021). The app, the worker and the tests' windows
// all use them, so their pixels match. Electron main process only.

import type { App } from 'electron';

export function applyRenderSwitches(app: App): void {
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-skia-runtime-opts');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  // HTML layers (ADR 0021) draw a page into a canvas with Chromium's HTML-in-Canvas API, which Chromium 152
  // to 156 keeps behind this Blink feature. Without it an html layer says it can't be drawn and nothing else changes.
  app.commandLine.appendSwitch('enable-blink-features', HTML_IN_CANVAS);
}

/** The Blink feature behind drawElementImage. Measured in Electron 44.4.5 and 45.3.3; check it on every Electron upgrade (ADR 0021). */
export const HTML_IN_CANVAS = 'CanvasDrawElement';
