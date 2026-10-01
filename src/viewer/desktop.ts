// The desktop app's bridge (ADR 0008): what the preload exposes to the page.
// The viewer stays web-only code, so everything here is optional; in a
// browser tab there is no bridge.

/** What the app knows about updates (ADR 0009). `notes` is the release page's URL. */
export type UpdateState =
  // Nothing known, or up to date.
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes: string }
  // `done` and `total` in bytes.
  | { status: 'downloading'; version: string; notes: string; done: number; total: number }
  | { status: 'restarting'; version: string }
  // `manual`: the app can't update itself where it is, so offer the release page instead.
  | { status: 'error'; message: string; version?: string; notes?: string; manual?: boolean };

/** Updates, in the installed app only (ADR 0009). */
export interface DesktopUpdates {
  state(): Promise<UpdateState>;
  /** Calls `cb` on every change. Returns a function that stops it. */
  onChange(cb: (state: UpdateState) => void): () => void;
  /** Checks for a newer version now, and returns what it found. */
  check(): Promise<UpdateState>;
  /** Downloads the newer version, replaces the app and restarts it. Progress and failures arrive as states. */
  install(): Promise<void>;
  /** Opens the release page of the version on offer. */
  openNotes(): Promise<void>;
}

/** A recent project, as the switcher shows it (ADR 0013). */
export interface ProjectEntry {
  path: string;
  name: string;
  /** The project on screen. */
  current: boolean;
  /** Its studio server runs, on screen or in the background. */
  open: boolean;
  missing?: boolean;
  /** Its threads working, waiting on the user's input, and the user's turn. */
  working: number;
  input: number;
  yours: number;
}

export interface DesktopBridge {
  /** The studio server's pairing token, handed over once. */
  readonly token: string;
  /** Shows a file in Finder. */
  reveal(path: string): Promise<void>;
  /** Opens a folder picker, then switches the app to the project chosen. Resolves to why it failed, or null. */
  openFolder(): Promise<string | null>;
  /** The recent projects with their threads' status. */
  projects(): Promise<ProjectEntry[]>;
  /** Asks for a name and place, makes the project, and switches to it. */
  newProject(): Promise<string | null>;
  /** Switches to a recent project. */
  openProject(path: string): Promise<string | null>;
  /** Missing when the app can't update, such as when it runs from the repo. */
  readonly updates?: DesktopUpdates;
}

declare global {
  interface Window {
    frameStudioDesktop?: DesktopBridge;
  }
}

/** The bridge when the page runs in the app; null in a browser. */
export function desktop(): DesktopBridge | null {
  return window.frameStudioDesktop ?? null;
}
