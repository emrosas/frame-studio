# 0002: Keep the viewer in plain TypeScript until M6, then move its UI to Svelte

Status: accepted, 2026-09-23

## Context

The viewer is about 3,000 lines of plain TypeScript and DOM code. It covers playback controls, the scrubber, the selection bar, the overlay and URL state. M3 to M5 add little UI. M6 adds the prompt panel, reference images and an iteration modal, and the later timeline and rig-controls panels add much more. The user normally builds UIs in Svelte.

Svelte 5 compiles to plain JavaScript, and `@sveltejs/vite-plugin-svelte` 7 supports the repo's Vite 8. It runs the same in a browser tab and in Electron (ADR 0001).

## Decision

- Until M6 the viewer stays plain TypeScript, and porting working UI now is churn.
- M6 starts by moving the viewer's UI to Svelte 5 with Vite. Controls, the selection bar and panels become components. The canvas view, the overlay, the clock and the pure selection and URL modules stay plain TypeScript, and the components wrap them.
- Use Svelte, not SvelteKit. The app needs no server rendering or routing, and SvelteKit inside Electron needs `adapter-static` plus workarounds for loading from `file://`.

## Consequences

- `src/engine`, `src/rigs` and `src/audio` never import Svelte. The single-file embed ships none of it, and the runtime budget is unchanged.
- UI work before M6 should keep logic in plain modules with unit tests, as `selection.ts`, `url.ts` and `mask.ts` do, so the port only rewrites the DOM code.
