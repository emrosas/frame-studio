/**
 * An Electron main script for tests: one hidden window on about:blank, with
 * the render switches every Frame Studio window uses, for Playwright to drive.
 * The embed tests open their HTML files in it, so pixels come from the same
 * Chromium as the render worker's (ADR 0008).
 */
import { app, BrowserWindow } from 'electron';
import { applyRenderSwitches } from '../../desktop/switches.ts';

applyRenderSwitches(app);
app.dock?.hide();
void app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 960, height: 540, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  void win.loadURL('about:blank');
});
