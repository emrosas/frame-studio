// Viewer entry. Pairs with the studio server, loads the scene library from it,
// boots the app, exposes window.studio, and keeps the library current:
//
// - Scene, project, rig and generator edits: the studio server says so on its
//   event stream, and the rebuilt library swaps in place, so the viewer keeps
//   its scene, frame, and play state (ADR 0008).
// - Viewer and engine code under npm run dev: Vite falls back to a full reload.
//   The URL carries ?scene=&frame=&layer=&part=&from=&to= and play state goes
//   through sessionStorage, so the reload lands on the same frame and selection.
// - A manual reload: the URL write is throttled, so it can trail the screen.
//   pagehide stores the frame and selection in sessionStorage and a reload
//   boots from them.

import './style.css';
import { flushSync, mount } from 'svelte';
import { App, RESUME_KEY, type StudioApi } from './app';
import Viewer from './components/Viewer.svelte';
import { ViewerUi, type ViewerActions } from './ui.svelte';
import { pair } from './pairing';
import { loadLibrary, type LoadedLibrary } from './scenes';
import { LIBRARY_EVENT } from '../studio/protocol';
import { studioEvents } from './studio-events';
import { bootUrlState, readUrlState, RELOAD_KEY } from './url';

declare global {
  interface Window {
    studio: StudioApi;
    /** Boot guard from index.html; shows an error if the viewer never starts. */
    __studioBoot?: { done(): void };
  }
}

function takeResumeFlag(): boolean {
  try {
    const flag = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return flag === '1';
  } catch {
    return false;
  }
}

/** The scene and frame stored at the last pagehide, removed so it is used at most once. */
function takeReloadRecord(): string | null {
  try {
    const record = sessionStorage.getItem(RELOAD_KEY);
    sessionStorage.removeItem(RELOAD_KEY);
    return record;
  } catch {
    return null;
  }
}

function navigationType(): string | undefined {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry?.type;
}

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <div id="app">.');

const paired = await pair();
if (!paired.ok) {
  root.textContent = paired.reason;
  window.__studioBoot?.done();
  throw new Error(paired.reason);
}

/** The library, loaded until it loads: after a failure, the page says why and tries again when files change. */
async function firstLibrary(): Promise<LoadedLibrary> {
  for (;;) {
    try {
      const library = await loadLibrary();
      root!.textContent = '';
      return library;
    } catch (err) {
      root!.textContent = `The studio could not load this folder's scenes and rigs: ${err instanceof Error ? err.message : String(err)}\nFix the file and save; this page tries again then.`;
      window.__studioBoot?.done();
      await new Promise<void>((resolve) => {
        const stop = studioEvents.on(LIBRARY_EVENT, () => {
          stop();
          resolve();
        });
      });
    }
  }
}
let loaded = await firstLibrary();

const url = bootUrlState(readUrlState(location.search), takeReloadRecord(), navigationType());

// The layout mounts first, so the footer takes its height out of the stage
// before the canvas measures it. The components only call actions once the
// user acts, by which time the App has filled them in.
const ui = new ViewerUi();
const actions = {} as ViewerActions;
mount(Viewer, { target: root, props: { ui, actions } });
flushSync();
const app = new App(
  root,
  loaded.library,
  {
    scene: url.scene,
    frame: url.frame,
    autoplay: takeResumeFlag(),
    selection: { layer: url.layer, part: url.part, from: url.from, to: url.to },
  },
  ui,
);
Object.assign(actions, app.actions);

window.studio = app.api;
studioEvents.onClosed(() => app.reportServerLost());
window.addEventListener('error', (e) => app.reportRuntimeError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => app.reportRuntimeError(e.reason));
window.__studioBoot?.done();

// Files changed: load the library again, one load at a time, skipping ones a newer change overtook.
let reloading: Promise<void> | null = null;
let wanted = 0;
studioEvents.on<{ generation: number }>(LIBRARY_EVENT, ({ generation }) => {
  wanted = Math.max(wanted, generation);
  reloading ??= (async () => {
    while (loaded.generation < wanted) {
      try {
        const next = await loadLibrary();
        if (next.generation < loaded.generation) break;
        loaded = next;
        app.setLibrary(loaded.library);
      } catch (err) {
        // Reported as a hot-update failure, so the next good swap clears it.
        app.reportHotFailure(err);
        break;
      }
    }
  })().finally(() => {
    reloading = null;
  });
});

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => app.prepareForReload());
  import.meta.hot.on('vite:error', (payload) => app.reportBuildError(payload.err));
  import.meta.hot.on('vite:afterUpdate', () => app.clearBuildError());
}
