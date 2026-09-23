// Viewer entry. Boots the app, exposes window.studio, and wires hot reload:
//
// - Scene JSON and rig edits: ./scenes is an accepted HMR dependency, so the
//   new library swaps in place and the viewer keeps its scene, frame, and play
//   state.
// - Anything else (engine, viewer code): Vite falls back to a full reload.
//   The URL carries ?scene=&frame=&layer=&part=&from=&to= and play state goes
//   through sessionStorage, so the reload lands on the same frame and selection.
// - A manual reload: the URL write is throttled, so it can trail the screen.
//   pagehide stores the frame and selection in sessionStorage and a reload
//   boots from them.

import './style.css';
import { App, RESUME_KEY, type StudioApi } from './app';
import { loadLibrary } from './scenes';
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

const url = bootUrlState(readUrlState(location.search), takeReloadRecord(), navigationType());
const app = new App(root, loadLibrary(), {
  scene: url.scene,
  frame: url.frame,
  autoplay: takeResumeFlag(),
  selection: { layer: url.layer, part: url.part, from: url.from, to: url.to },
});

window.studio = app.api;
window.addEventListener('error', (e) => app.reportRuntimeError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => app.reportRuntimeError(e.reason));
window.__studioBoot?.done();

if (import.meta.hot) {
  import.meta.hot.accept('./scenes', (mod) => {
    if (!mod) {
      app.reportHotFailure();
      return;
    }
    try {
      app.setLibrary((mod as unknown as typeof import('./scenes')).loadLibrary());
    } catch (err) {
      // Reported as a hot-update failure, so the next good swap clears it.
      app.reportHotFailure(err);
    }
  });
  import.meta.hot.on('vite:beforeFullReload', () => app.prepareForReload());
  import.meta.hot.on('vite:error', (payload) => app.reportBuildError(payload.err));
  import.meta.hot.on('vite:afterUpdate', () => app.clearBuildError());
}
