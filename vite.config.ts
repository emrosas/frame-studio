/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Rigs and generators outside src/ import the built-ins by this name (ADR 0008).
  resolve: { alias: [{ find: /^@frame-studio\/(.*)$/, replacement: `${resolve(import.meta.dirname, 'src')}/$1` }] },
  build: {
    // The viewer boots with top-level await (pairing, then the library).
    target: 'es2022',
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
