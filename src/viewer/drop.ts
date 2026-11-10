// Dragging from the Library onto the timeline: what a dragged item is, what it
// becomes where it lands, and where it lands. Pure maths on frames and rows, so
// the timeline component only measures the pointer and draws the ghost.

import { isPictureFile, isVideoFile } from '../engine/picture';
import { snapDelta } from './timeline';
import type { ShotHead } from './ui.svelte';

/** The drag data type our own drags carry, so the window's file drop leaves them alone. */
export const DRAG_TYPE = 'application/x-frame-studio-item';

/** An image shows this long when placed, as the server places it. */
export const IMAGE_SECONDS = 3;

/** A card or a media row, as it travels in a drag. `seconds` is its length when known. */
export type LibraryItem = { kind: 'scene'; key: string; label: string; seconds: number | null } | { kind: 'media'; file: string; label: string; seconds: number | null };

/** What the timeline on screen shows: a composition's tracks, or a scene (a film's shots count as a scene). */
export type DropTarget = 'composition' | 'scene';

/** What an item turns into where it lands, or why it can't go there. */
export type DropKind = { as: 'clip' } | { as: 'cue' } | { as: 'refused'; reason: string };

/** Where a clip lands: on a track, or on a new one at the top or bottom of the stack. */
export type DropTrack = { into: 'track'; track: string } | { into: 'top' } | { into: 'bottom' };

export function isPicture(item: LibraryItem): boolean {
  return item.kind === 'media' && isPictureFile(item.file);
}

/** A scene, composition or picture becomes a clip in a composition; a sound file becomes a cue anywhere. Scenes never place pictures or scenes (ADR 0014). */
export function dropKind(item: LibraryItem, target: DropTarget, self: string | null): DropKind {
  if (item.kind === 'media' && !isPictureFile(item.file)) return { as: 'cue' };
  if (target === 'scene') {
    return { as: 'refused', reason: item.kind === 'scene' ? 'A scene draws and places nothing. Drop scenes on a video, or start one with New video.' : 'Images and videos go in a video, not a scene. Open a video, or start one with New video.' };
  }
  if (item.kind === 'scene' && item.key === self) return { as: 'refused', reason: "A video can't hold itself." };
  return { as: 'clip' };
}

/** How many frames of the timeline an item would cover, at `fps`, before the scene's end trims a cue. At least one. */
export function dropFrames(item: LibraryItem, fps: number): number {
  const seconds = item.kind === 'media' && isPictureFile(item.file) && !isVideoFile(item.file) ? IMAGE_SECONDS : (item.seconds ?? IMAGE_SECONDS);
  return Math.max(1, Math.round(seconds * fps));
}

/**
 * Where a dropped item starts, in frames. It sits from the boundary under the pointer and snaps either edge to
 * `targets` within SNAP_PX, as a clip drag does. A clip may run past the end, since the video grows; a cue
 * starts inside the scene, since the server trims it to the scene's end.
 */
export function dropStart(at: number, frames: number, targets: readonly number[], pxPerFrame: number, total: number, kind: 'clip' | 'cue'): number {
  const start = Math.max(0, at);
  const snapped = Math.max(0, start + snapDelta([start, start + frames], 0, targets, pxPerFrame));
  return kind === 'cue' ? Math.min(snapped, Math.max(0, total - 1)) : snapped;
}

/**
 * The track under a height `y` measured from the top of the track rows, `height` tall with `lanes` rows. Above
 * them is a new track on top, below them a new one at the bottom of the stack.
 */
export function dropTrack(y: number, height: number, lanes: number, heads: readonly ShotHead[]): DropTrack {
  if (lanes <= 0 || height <= 0 || y < 0) return { into: 'top' };
  if (y >= height) return { into: 'bottom' };
  const lane = Math.min(lanes - 1, Math.floor((y / height) * lanes));
  const track = heads.find((h) => lane >= h.lane && lane < h.lane + h.lanes)?.track;
  return track === undefined ? { into: 'top' } : { into: 'track', track };
}

/** Reads our drag's item back, or null for anyone else's drag. */
export function readItem(data: string): LibraryItem | null {
  try {
    const item = JSON.parse(data) as Partial<LibraryItem> | null;
    if (!item || typeof item.label !== 'string') return null;
    const seconds = typeof item.seconds === 'number' && Number.isFinite(item.seconds) ? item.seconds : null;
    if (item.kind === 'scene' && typeof item.key === 'string') return { kind: 'scene', key: item.key, label: item.label, seconds };
    if (item.kind === 'media' && typeof item.file === 'string') return { kind: 'media', file: item.file, label: item.label, seconds };
  } catch {
    // Not ours.
  }
  return null;
}

const MEDIA = /\.(mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|webp|mp4|m4v|mov|webm)$/i;

/** The sound, video and image files among files dropped from the computer, which import into media/ (ADR 0012, 0014). */
export function mediaFiles(files: FileList | readonly File[] | undefined | null): File[] {
  return [...(files ?? [])].filter((f) => f.type.startsWith('audio/') || f.type.startsWith('video/') || MEDIA.test(f.name));
}
