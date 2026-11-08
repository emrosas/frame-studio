// Background mode, for the app's own tests: FRAME_STUDIO_BACKGROUND=1. The app
// never gets in the way of whoever is at the computer. On macOS it stays out of
// the Dock and the app switcher, and its windows show without taking focus,
// fully transparent, with clicks passing through to whatever is under them.
// Playwright drives the pages through the DevTools protocol, which needs none
// of that: its input goes straight to the page, and its screenshots read the
// page, not the screen. The windows still count as shown, so pages run as usual.

import { app, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

export const background = process.env.FRAME_STUDIO_BACKGROUND === '1';

/** Call before the app is ready: a background app never becomes the active one. */
export function stayInBackground(): void {
  if (!background) return;
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
}

/** A window's options: in background mode it starts hidden, for `reveal` to show without focus. */
export const windowOptions = (options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions => (background ? { ...options, show: false, opacity: 0 } : options);

/** Shows a window, and in background mode leaves the focus where it was. */
export function reveal(win: BrowserWindow): void {
  if (!background) {
    win.show();
    return;
  }
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
}

/** Brings a window forward, except in background mode, where it only makes sure the window shows. */
export function bringForward(win: BrowserWindow): void {
  if (background) {
    if (!win.isVisible()) reveal(win);
    return;
  }
  win.focus();
}
