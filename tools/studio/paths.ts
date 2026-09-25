// Where the studio keeps its handoff files and references. Its own module, so
// the MCP server, the workspace and the studio server can share it without
// importing each other. Node only.

import { join } from 'node:path';
import { ROOT } from '../scene-files.ts';

/** The handoff folder. FRAME_STUDIO_DIR moves it, so tests never touch a real queue. */
export const STUDIO_DIR = process.env.FRAME_STUDIO_DIR ?? join(ROOT, '.frame-studio');
export const REFERENCES_DIR = join(ROOT, 'references');

/**
 * What a Vite server's inline config tells the studio server plugin. Tools
 * start Vite with agents off (startVite), so only the dev server the viewer
 * uses runs the studio's agents.
 */
export interface StudioInlineConfig {
  frameStudio?: { agents?: boolean };
}
