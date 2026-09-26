/** Playwright's Chromium, for tests that drive the viewer's interface. Pixels come from the render worker in Electron. */
import { chromium, type Browser } from 'playwright';

export function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}
