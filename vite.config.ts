/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // The viewer, and render mode for the headless tools (render.html).
      input: { main: resolve(import.meta.dirname, 'index.html'), render: resolve(import.meta.dirname, 'render.html') },
    },
  },
  optimizeDeps: {
    // Scan both pages and pre-bundle the export libraries at startup. Otherwise
    // Vite finds them on first use and reloads the page mid-export.
    entries: ['index.html', 'render.html'],
    include: ['mediabunny', 'gifenc'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/browser/**', 'node_modules/**'],
  },
});
