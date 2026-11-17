// Carousels (ADR 0022): stills grouped in order, as a post that is swiped
// through. project.json holds them as { id, slides }, where slides are scene
// ids. This is the pure part: finding a still's carousel and the edits a hand
// or a tool makes to the list. Import-free, so Node and the viewer share it.

export interface Carousel {
  id: string;
  /** Scene ids, in the order they are swiped. */
  slides: string[];
}

/** What can be done to the list of carousels. */
export type CarouselEdit =
  /** A new carousel from stills, in order. */
  | { op: 'create'; id: string; slides: string[] }
  /** Adds a still, at `at` or the end. A still in another carousel leaves it. */
  | { op: 'add'; carousel: string; scene: string; at?: number }
  /** Takes a still out. The scene stays; a carousel left empty goes. */
  | { op: 'remove'; carousel: string; scene: string }
  /** Moves a slide to position `to`. */
  | { op: 'move'; carousel: string; scene: string; to: number }
  /** Ungroups it. The stills stay. */
  | { op: 'delete'; carousel: string };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The carousel a scene is a slide of, with its place in it, or null. */
export function carouselOf(carousels: readonly Carousel[] | undefined, sceneId: string): { carousel: Carousel; index: number } | null {
  for (const carousel of carousels ?? []) {
    const index = carousel.slides.indexOf(sceneId);
    if (index >= 0) return { carousel, index };
  }
  return null;
}

/** The carousels after an edit. Throws with the reason when the edit can't be made. */
export function applyCarouselEdit(carousels: readonly Carousel[], edit: CarouselEdit): Carousel[] {
  const next = carousels.map((c) => ({ id: c.id, slides: [...c.slides] }));
  const find = (id: string) => {
    const found = next.find((c) => c.id === id);
    if (!found) throw new Error(`There's no carousel "${id}".`);
    return found;
  };
  const drop = (scene: string) => {
    for (const c of next) c.slides = c.slides.filter((s) => s !== scene);
  };
  const tidy = () => next.filter((c) => c.slides.length > 0);
  switch (edit.op) {
    case 'create': {
      if (!ID.test(edit.id) || edit.id.length > 64) throw new Error(`A carousel's id is lowercase letters, digits and single hyphens, like "launch", got "${edit.id}".`);
      if (next.some((c) => c.id === edit.id)) throw new Error(`There is already a carousel "${edit.id}".`);
      if (edit.slides.length === 0) throw new Error('A carousel needs at least one still.');
      if (new Set(edit.slides).size !== edit.slides.length) throw new Error('A still is in a carousel once.');
      for (const scene of edit.slides) drop(scene);
      return [...tidy(), { id: edit.id, slides: [...edit.slides] }];
    }
    case 'add': {
      find(edit.carousel);
      drop(edit.scene);
      const into = find(edit.carousel);
      const at = edit.at === undefined ? into.slides.length : Math.max(0, Math.min(into.slides.length, Math.round(edit.at)));
      into.slides.splice(at, 0, edit.scene);
      return tidy();
    }
    case 'remove': {
      const from = find(edit.carousel);
      if (!from.slides.includes(edit.scene)) throw new Error(`"${edit.scene}" isn't a slide of "${edit.carousel}".`);
      from.slides = from.slides.filter((s) => s !== edit.scene);
      return tidy();
    }
    case 'move': {
      const within = find(edit.carousel);
      const from = within.slides.indexOf(edit.scene);
      if (from < 0) throw new Error(`"${edit.scene}" isn't a slide of "${edit.carousel}".`);
      within.slides.splice(from, 1);
      within.slides.splice(Math.max(0, Math.min(within.slides.length, Math.round(edit.to))), 0, edit.scene);
      return next;
    }
    case 'delete':
      find(edit.carousel);
      return next.filter((c) => c.id !== edit.carousel);
  }
}

/** Why `input` isn't a carousel edit, or null when it is. */
export function checkCarouselEdit(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'a carousel edit must be a JSON object';
  const e = input as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v !== '';
  const whole = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  switch (e.op) {
    case 'create':
      return text(e.id) && Array.isArray(e.slides) && e.slides.every(text) ? null : 'create takes id and slides, a list of scene ids';
    case 'add':
      return text(e.carousel) && text(e.scene) && (e.at === undefined || whole(e.at)) ? null : 'add takes carousel, scene and an optional at';
    case 'remove':
      return text(e.carousel) && text(e.scene) ? null : 'remove takes carousel and scene';
    case 'move':
      return text(e.carousel) && text(e.scene) && whole(e.to) ? null : 'move takes carousel, scene and to, a position';
    case 'delete':
      return text(e.carousel) ? null : 'delete takes carousel';
    default:
      return `unknown carousel edit ${JSON.stringify(e.op)}`;
  }
}

/** A slide's file in a carousel's export: numbered, so the folder sorts as the post swipes. */
export function slideFileName(index: number, sceneId: string, format: string): string {
  return `${String(index + 1).padStart(2, '0')}-${sceneId}.${format}`;
}

/** A fresh id for a new slide of a carousel: "<carousel>-<n>", the first n no scene has. */
export function freshSlideId(carousel: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const id = `${carousel}-${n}`;
    if (!taken.has(id)) return id;
  }
}
