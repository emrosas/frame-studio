// The desktop app's bridge (ADR 0008): what the preload exposes to the page.
// The viewer stays web-only code, so everything here is optional; in a
// browser tab there is no bridge.

export interface DesktopBridge {
  /** The studio server's pairing token, handed over once. */
  readonly token: string;
  /** Shows a file in Finder. */
  reveal(path: string): Promise<void>;
  /** Opens a studio folder picker, then switches the app to the folder chosen. */
  openFolder(): Promise<void>;
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
