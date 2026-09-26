// Browser tests: the studio server, the viewer in Playwright's Chromium, and
// render workers in Electron. Slower than the unit suite and needs the
// browsers installed (npx playwright install chromium-headless-shell, and
// Electron through npm install), so it runs on its own: npm run test:browser.
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The code host loads rigs through Vite's runner here, so it needs the built-ins' name too (ADR 0008).
  resolve: { alias: [{ find: /^@frame-studio\/(.*)$/, replacement: `${resolve(import.meta.dirname, 'src')}/$1` }] },
  test: {
    environment: 'node',
    include: ['tests/browser/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
