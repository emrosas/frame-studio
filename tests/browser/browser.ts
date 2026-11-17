/** Playwright's Chromium, for tests that drive the viewer's interface. Pixels come from the render worker in Electron. */
import { chromium, type Browser } from 'playwright';

/**
 * The viewer draws html layers with Chromium's HTML-in-Canvas API (ADR 0021), which the app turns on with
 * this Blink feature (desktop/switches.ts). Playwright's Chromium has it behind the same one.
 */
export function launchBrowser(options: { htmlInCanvas?: boolean } = {}): Promise<Browser> {
  return chromium.launch(options.htmlInCanvas === false ? {} : { args: ['--enable-blink-features=CanvasDrawElement'] });
}
