// Browser tests: render.html in Playwright's headless Chromium. Slower than
// the unit suite and needs the browser installed (npx playwright install
// chromium-headless-shell), so it runs on its own: npm run test:browser.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
