// Posters for the viewer's library: a frame of each scene and composition,
// small, in .frame-studio/thumbs/<id>-<hash>.png. The hash covers everything
// the picture depends on (the scene, what it places, the cast and the rigs), so
// a change makes a new file and an old file is never stale. The viewer asks
// where each stands and gets the ones that exist; the rest render here, one at
// a time and at low priority, and arrive as push events, so a request never
// waits on the render worker and an export never waits on a poster. Node only.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Scene, World } from '../../src/engine/types.ts';
import { HttpError } from './http.ts';

/** The widest a poster gets, for a landscape frame and a portrait one. */
const LANDSCAPE_WIDTH = 480;
const PORTRAIT_WIDTH = 270;
const FILE = /^[a-z0-9_-]+-[0-9a-f]{12}\.png$/i;

interface PosterEntry {
  key: string;
  scene: Scene | null;
  project: string | null;
  kind: 'scene' | 'composition';
  world: World;
}

export interface ThumbsOptions {
  dir: string;
  enabled: boolean;
  /** The folder's entries now, and what every picture depends on besides them (the rigs). */
  entries(): Promise<{ entries: readonly PosterEntry[]; shared: unknown; media?: readonly { file: string; bytes: number; modified: number }[] }>;
  /** Writes frame `frame` of scene `key` to `path`, scaled to fit `maxWidth`. */
  render(key: string, frame: number, path: string, maxWidth: number): Promise<unknown>;
  /** Tells pages a poster is ready. */
  push(key: string, file: string): void;
}

/** What goes in a scene's picture: itself and everything it places, deepest included. */
function closure(scene: Scene, world: World): Scene[] {
  const seen = new Map<string, Scene>([[scene.id, scene]]);
  const walk = (s: Scene) => {
    for (const layer of s.layers) {
      const placed = layer.scene !== undefined ? world.scenes?.get(layer.scene) : undefined;
      if (placed && !seen.has(placed.id)) {
        seen.set(placed.id, placed);
        walk(placed);
      }
    }
  };
  walk(scene);
  return [...seen.values()];
}

/** The frame a poster shows: a third of the way in, past any fade from black. */
export const posterFrame = (scene: Pick<Scene, 'fps' | 'duration'>): number => Math.floor((scene.duration * scene.fps) / 3);

const slug = (key: string) => key.replace(/[^a-z0-9-]/gi, '_');

export class Thumbs {
  private readonly options: ThumbsOptions;
  /** Posters to make, newest wanted hash per key. */
  private readonly wanted = new Map<string, { file: string; frame: number; maxWidth: number }>();
  /** Posters that failed, so a rig that throws isn't tried again until something changes. */
  private readonly failed = new Set<string>();
  private running = false;
  private closed = false;

  constructor(options: ThumbsOptions) {
    this.options = options;
  }

  /** Every scene's poster file, or null where it isn't there yet. Missing ones start rendering. */
  async list(): Promise<Record<string, string | null>> {
    if (!this.options.enabled) return {};
    const { entries, shared, media = [] } = await this.options.entries();
    const out: Record<string, string | null> = {};
    this.wanted.clear();
    for (const entry of entries) {
      const scene = entry.scene;
      if (!scene || entry.project !== null) continue;
      // A composition with nothing on it has no picture yet.
      if (entry.kind === 'composition' && scene.layers.length === 0) {
        out[entry.key] = null;
        continue;
      }
      // What it places on disk counts too, so a replaced video gets a new poster.
      const scenes = closure(scene, entry.world);
      const files = new Set(scenes.flatMap((s) => s.layers.flatMap((l) => (l.file !== undefined ? [l.file] : []))));
      const hash = createHash('sha256')
        .update(JSON.stringify([scenes, entry.world.cast ?? null, shared, media.filter((m) => files.has(m.file))]))
        .digest('hex')
        .slice(0, 12);
      const file = `${slug(entry.key)}-${hash}.png`;
      if (await stat(join(this.options.dir, file)).catch(() => null)) {
        out[entry.key] = file;
        continue;
      }
      out[entry.key] = null;
      if (!this.failed.has(file)) {
        const [width, height] = scene.size;
        this.wanted.set(entry.key, { file, frame: posterFrame(scene), maxWidth: width >= height ? LANDSCAPE_WIDTH : PORTRAIT_WIDTH });
      }
    }
    void this.drain();
    return out;
  }

  /** Renders what's wanted, one at a time. Each poster waits behind every other job the worker has. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.wanted.entries().next();
        if (next.done || this.closed) return;
        const [key, poster] = next.value;
        this.wanted.delete(key);
        try {
          await mkdir(this.options.dir, { recursive: true });
          await this.options.render(key, poster.frame, join(this.options.dir, poster.file), poster.maxWidth);
          await this.sweep(key, poster.file);
          this.options.push(key, poster.file);
        } catch {
          // The placeholder stays. The scene's own errors show when it's opened.
          this.failed.add(poster.file);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Removes the key's older posters. */
  private async sweep(key: string, keep: string): Promise<void> {
    const prefix = `${slug(key)}-`;
    for (const name of await readdir(this.options.dir).catch(() => [])) {
      if (name !== keep && name.startsWith(prefix) && /^[0-9a-f]{12}\.png$/.test(name.slice(prefix.length))) await rm(join(this.options.dir, name), { force: true });
    }
  }

  async serve(file: string, res: ServerResponse): Promise<void> {
    const data = FILE.test(file) ? await readFile(join(this.options.dir, file)).catch(() => null) : null;
    if (!data) throw new HttpError(404, 'No such poster.');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    // The name carries a hash of what it shows.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(data);
  }

  close(): void {
    this.closed = true;
    this.wanted.clear();
  }
}
