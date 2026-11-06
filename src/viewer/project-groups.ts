// The sidebar's groups (ADR 0013): one per listed project, the one on screen
// first and open, built from the viewer's live list for that project and from
// what the app read off disk for the others. A browser has one group.

import type { ProjectEntry, ProjectItem } from './desktop';
import type { SceneOption } from './ui.svelte';

/** A row of a group: a scene option, with a poster file for a project not on screen. */
export type GroupRow = SceneOption & { poster?: string | null };

export interface FilmGroup {
  id: string;
  name: string;
  rows: GroupRow[];
}

/** What a project's threads ask for, the most pressing first. */
export interface GroupStatus {
  kind: 'input' | 'your_turn' | 'working';
  /** "1 waiting on your input, 2 working". */
  label: string;
}

export interface ProjectGroup {
  path: string;
  name: string;
  /** On screen. */
  current: boolean;
  missing: boolean;
  open: boolean;
  status: GroupStatus | null;
  videos: GroupRow[];
  scenes: GroupRow[];
  films: FilmGroup[];
  /** What the fold hides. */
  count: number;
}

export function groupStatus(p: Pick<ProjectEntry, 'working' | 'input' | 'yours'>): GroupStatus | null {
  const label = [p.input > 0 ? `${p.input} waiting on your input` : '', p.yours > 0 ? `${p.yours} your turn` : '', p.working > 0 ? `${p.working} working` : ''].filter(Boolean).join(', ');
  if (p.input > 0) return { kind: 'input', label };
  if (p.yours > 0) return { kind: 'your_turn', label };
  return p.working > 0 ? { kind: 'working', label } : null;
}

const rowOf = (item: ProjectItem, film: string | null, group: string | null): GroupRow => ({
  key: item.key,
  label: item.label,
  file: item.file,
  invalid: item.invalid,
  film,
  group,
  main: false,
  kind: item.kind,
  usedIn: [],
  format: null,
  poster: item.poster,
});

/** The older films in a live list, in its order. */
function liveFilms(scenes: readonly SceneOption[]): FilmGroup[] {
  const films: FilmGroup[] = [];
  for (const option of scenes) {
    if (option.film === null) continue;
    const last = films.at(-1);
    if (last && last.id === option.film) last.rows.push(option);
    else films.push({ id: option.film, name: option.group ?? option.film, rows: [option] });
  }
  return films;
}

export function projectGroups(input: {
  /** The recent projects, most recent first. Empty in a browser. */
  entries: readonly ProjectEntry[];
  /** The live list of the project on screen. */
  scenes: readonly SceneOption[];
  /** The project on screen, for when the list hasn't arrived or there is none. */
  folder: { path: string; name: string };
  /** Which folds you opened or closed, by path. A project not in here follows being on screen. */
  folds: Readonly<Record<string, boolean>>;
  query: string;
}): ProjectGroup[] {
  const query = input.query.trim().toLowerCase();
  const matches = (row: GroupRow) => query === '' || row.label.toLowerCase().includes(query);
  const onScreen = input.entries.find((e) => e.current) ?? input.entries.find((e) => e.path === input.folder.path);

  const group = (path: string, name: string, current: boolean, entry: ProjectEntry | undefined): ProjectGroup => {
    const videos = current ? input.scenes.filter((s) => s.film === null && s.kind === 'composition') : (entry?.videos ?? []).map((i) => rowOf(i, null, null));
    const scenes = current ? input.scenes.filter((s) => s.film === null && s.kind === 'scene') : (entry?.scenes ?? []).map((i) => rowOf(i, null, null));
    const films = current ? liveFilms(input.scenes) : (entry?.films ?? []).map((f) => ({ id: f.id, name: f.name, rows: f.items.map((i) => rowOf(i, f.id, f.name)) }));
    const shownFilms = films.map((f) => ({ ...f, rows: f.rows.filter(matches) })).filter((f) => f.rows.length > 0);
    const shownVideos = videos.filter(matches);
    const shownScenes = scenes.filter(matches);
    const missing = entry?.missing === true;
    return {
      path,
      name,
      current,
      missing,
      open: !missing && (query !== '' || (input.folds[path] ?? current)),
      status: entry && !missing ? groupStatus(entry) : null,
      videos: shownVideos,
      scenes: shownScenes,
      films: shownFilms,
      count: shownVideos.length + shownScenes.length + shownFilms.length,
    };
  };

  const first = group(onScreen?.path ?? input.folder.path, onScreen?.name ?? input.folder.name, true, onScreen);
  const others = input.entries.filter((e) => e !== onScreen).map((e) => group(e.path, e.name, false, e));
  const groups = [first, ...others];
  return query === '' ? groups : groups.filter((g) => g.count > 0);
}
