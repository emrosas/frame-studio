// What the viewer keeps between visits. In a browser that's localStorage, and
// sessionStorage for unsent prompts. In the app every project's server has its
// own port and so its own storage, so both live in the main process instead
// (ADR 0013): prefs in the app's settings, drafts per project until it quits.

import { desktop } from './desktop';

function bridge() {
  return typeof window === 'undefined' ? null : desktop();
}

/** The app's copies for this page; the bridge's are frozen, and only as new as the page. */
const prefs = new Map(Object.entries(bridge()?.boot.prefs ?? {}));
const drafts = new Map(Object.entries(bridge()?.boot.drafts ?? {}));
const DRAFT_PREFIX = 'frame-studio:draft:';

export function readPref(key: string): string | null {
  if (bridge()) return prefs.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  const app = bridge();
  if (app) {
    prefs.set(key, value);
    app.setPref(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; it lasts until reload
  }
}

/** A prompt not sent yet: `new` for the new thread, or a thread's id. */
export function readDraft(key: string): string {
  if (bridge()) return drafts.get(key) ?? '';
  try {
    return sessionStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(key: string, text: string): void {
  const app = bridge();
  if (app) {
    if ((drafts.get(key) ?? '') === text) return;
    drafts.set(key, text);
    app.setDraft(key, text);
    return;
  }
  try {
    if (text === '') sessionStorage.removeItem(DRAFT_PREFIX + key);
    else sessionStorage.setItem(DRAFT_PREFIX + key, text);
  } catch {
    // storage unavailable; the draft lasts until reload
  }
}
