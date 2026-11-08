// The sidebar's Footage view (ADR 0013): one row per listed project, the one
// on screen first, then the other recent projects, most recent first. A row
// opens that project's library, where its videos and scenes are picked. The
// project on screen counts from the viewer's live list, the others from what
// the app read off disk. A browser has one row.

import type { ProjectEntry, ProjectItem } from './desktop';
import type { SceneOption } from './ui.svelte';

export interface ProjectRow {
  path: string;
  name: string;
  /** On screen. */
  current: boolean;
  missing: boolean;
  /** Its videos, scenes and older films' scenes, or with a filter, those that match. */
  count: number;
}

const labelsOf = (entry: ProjectEntry | undefined): string[] => {
  const items: ProjectItem[] = [...(entry?.videos ?? []), ...(entry?.scenes ?? []), ...(entry?.films ?? []).flatMap((f) => f.items)];
  return items.map((i) => i.label);
};

export function projectRows(input: {
  /** The recent projects, most recent first. Empty in a browser. */
  entries: readonly ProjectEntry[];
  /** The live list of the project on screen. */
  scenes: readonly SceneOption[];
  /** The project on screen, for when the list hasn't arrived or there is none. */
  folder: { path: string; name: string };
  /** Matches a project's name or the name of anything in it. */
  query: string;
}): ProjectRow[] {
  const query = input.query.trim().toLowerCase();
  const onScreen = input.entries.find((e) => e.current) ?? input.entries.find((e) => e.path === input.folder.path);

  const row = (path: string, name: string, current: boolean, entry: ProjectEntry | undefined): ProjectRow | null => {
    const labels = current ? input.scenes.map((s) => s.label) : labelsOf(entry);
    const matching = labels.filter((l) => l.toLowerCase().includes(query));
    if (query !== '' && matching.length === 0 && !name.toLowerCase().includes(query)) return null;
    return { path, name, current, missing: entry?.missing === true, count: query === '' ? labels.length : matching.length };
  };

  const first = row(onScreen?.path ?? input.folder.path, onScreen?.name ?? input.folder.name, true, onScreen);
  const others = input.entries.filter((e) => e !== onScreen).map((e) => row(e.path, e.name, false, e));
  return [first, ...others].filter((r): r is ProjectRow => r !== null);
}
