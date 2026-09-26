/**
 * Opens pages in Electron through Playwright, for tests that compare pixels
 * with the render worker (ADR 0008): same binary, same switches.
 */
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { REPO } from '../../tools/studio/folder';
import { childEnv, electronBinary } from '../../tools/studio/electron-worker';

export interface ElectronPage {
  app: ElectronApplication;
  page: Page;
  close(): Promise<void>;
}

export async function electronPage(): Promise<ElectronPage> {
  const app = await _electron.launch({
    executablePath: electronBinary(),
    args: [join(REPO, 'tests/browser/electron-window.ts')],
    env: childEnv() as Record<string, string>,
  });
  const page = await app.firstWindow();
  return { app, page, close: () => app.close() };
}
