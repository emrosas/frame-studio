// Turns raw scene files into a validated scene library. Pure: the caller passes
// file contents, the validators, and the registry factories, so this is
// testable without Vite or the real engine. The folder is a project (ADR
// 0013): project.json at its top (name, default format, cast), scenes/ that
// draw, and compositions/ that arrange them. Films made before that live in
// projects/<id>/ (ADR 0007), with project.json, scenes and rigs of their own,
// until converted.

import type { GeneratorRegistry } from '../audio/types';
import type { CompositionValidation, ProjectContext, ProjectFile, ProjectValidation, SchemaOwner, ValidationResult } from '../engine';
import type { Cast, Rig, RigRegistry, Scene, World } from '../engine/types';

export type ValidateScene = (input: unknown, registry?: RigRegistry, generators?: GeneratorRegistry, project?: ProjectContext) => ValidationResult;

/** What building projects needs besides the scene validator. */
export interface ProjectTools {
  validateProject: (input: unknown, registry?: RigRegistry, sceneIds?: readonly string[]) => ProjectValidation;
  sceneGraphErrors: (scenes: ReadonlyMap<string, Scene>) => Map<string, string[]>;
  /** The registry a project's scenes draw with: the global rigs plus the project's own. Throws on a clash. */
  createProjectRegistry: (rigs: readonly Rig[]) => RigRegistry;
  /** Each project's own rigs, from projects/<id>/rigs/, by project id. */
  rigs?: Readonly<Record<string, readonly Rig[]>>;
  /** Compositions (ADR 0013). Without it, compositions/ is left unread. */
  validateComposition?: (
    input: unknown,
    registry: RigRegistry | undefined,
    generators: ReadonlyMap<string, SchemaOwner> | undefined,
    context: Omit<ProjectContext, 'kind' | 'fps' | 'size'>,
  ) => CompositionValidation;
  /** The folder's project.json (ADR 0013): its cast, checked like an M9 project's, with fps and size optional. */
  validateFolderProject?: (input: unknown, registry?: RigRegistry) => { ok: true; project: FolderProject } | { ok: false; errors: string[] };
}

/** The folder's project.json (ADR 0013): its name, the format new scenes and compositions start from, its cast. */
export interface FolderProject {
  name?: string;
  fps?: number;
  size?: [number, number];
  cast?: Record<string, { rig: string; params?: Record<string, unknown> }>;
}

export interface ProjectEntry {
  /** The folder name, e.g. "bears-story". */
  id: string;
  /** The name to show: project.json's name, else the id. */
  name: string;
  /** Repo-relative, e.g. "projects/bears-story/project.json". */
  file: string;
  project: ProjectFile | null;
  /** The main scene's key, when project.json names one. */
  main: string | null;
  /** Problems with project.json or the project's rigs, each "path: message". */
  errors: readonly string[];
}

export interface SceneEntry {
  /**
   * Picker and URL key: a loose scene's id, or the file path when the id is missing or taken; a
   * project scene's qualified id, "<project>/<scene>".
   */
  key: string;
  /** Module path, e.g. "/scenes/fly-test.json". */
  path: string;
  /** Repo-relative file, e.g. "scenes/fly-test.json", for messages. */
  file: string;
  /** The validated scene, or null when the file is invalid. */
  scene: Scene | null;
  /** Everything wrong with the file, each "path: message". Empty when valid. */
  errors: readonly string[];
  /** The project it belongs to, or null for a loose scene. */
  project: string | null;
  /** The rigs it draws with: the global library, and its project's own. Null when that failed to build. */
  registry: RigRegistry | null;
  /** The sibling scenes it can place and its project's cast; empty for a loose scene. */
  world: World;
  /** What it was checked against in its project, for checking an edit the same way; null for a loose scene. */
  context: ProjectContext | null;
  /** A scene draws; a composition arranges (ADR 0013). An M9 project's scenes are scenes. */
  kind: 'scene' | 'composition';
}

export interface SceneLibrary {
  entries: readonly SceneEntry[];
  projects: readonly ProjectEntry[];
  /** Null when the rig registry failed to build; nothing can render then. */
  registry: RigRegistry | null;
  /** Null when the generator list failed to build; scenes then play silent. */
  generators: GeneratorRegistry | null;
  /** Problems that affect every scene (e.g. the rig registry failed to build). */
  errors: readonly string[];
  /** The folder's project.json (ADR 0013): null when it has none. */
  folder?: { file: string; project: FolderProject | null; errors: readonly string[] } | null;
  /** The studio folder's sound files (ADR 0012), when the library came from a studio server. */
  media?: readonly { file: string; bytes: number; modified: number }[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

function declaredId(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const id = (json as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/** "/projects/<id>/<file>" split into its project id and file stem, or null for other paths. */
function projectPath(path: string): { project: string; stem: string } | null {
  const m = /^\/projects\/([^/]+)\/([^/]+)\.json$/.exec(path);
  return m ? { project: m[1], stem: m[2] } : null;
}

export function buildLibrary(
  files: Readonly<Record<string, string>>,
  validate: ValidateScene,
  createRegistry: () => RigRegistry,
  createGenerators: () => GeneratorRegistry = () => new Map(),
  projectTools?: ProjectTools,
): SceneLibrary {
  const errors: string[] = [];
  let registry: RigRegistry | null = null;
  try {
    registry = createRegistry();
  } catch (err) {
    errors.push(`rig registry: ${message(err)} (fix the rig list in src/rigs/index.ts)`);
  }
  let generators: GeneratorRegistry | null = null;
  try {
    generators = createGenerators();
  } catch (err) {
    errors.push(`audio generators: ${message(err)} (fix the generator list in src/audio/index.ts)`);
  }

  const entries: SceneEntry[] = [];
  const byKey = new Map<string, SceneEntry>();

  // The folder's project.json (ADR 0013): its cast reaches every scene.
  let folder: SceneLibrary['folder'] = null;
  if ('/project.json' in files) {
    let project: FolderProject | null = null;
    const folderErrors: string[] = [];
    try {
      const json = JSON.parse(files['/project.json']) as unknown;
      const checked = projectTools?.validateFolderProject?.(json, registry ?? undefined);
      if (!checked) project = json as FolderProject;
      else if (checked.ok) project = checked.project;
      else folderErrors.push(...checked.errors);
    } catch (err) {
      folderErrors.push(`invalid JSON: ${message(err)}`);
    }
    folder = { file: 'project.json', project, errors: folderErrors };
  }
  const cast: Cast = folder?.project?.cast ? (folder.project.cast as Cast) : EMPTY_CAST;
  // The folder's scenes and compositions by id, with their lengths and frame rates, which clips are checked against.
  const lengths = new Map<string, { duration: number; fps?: number }>();
  for (const path of Object.keys(files)) {
    if (!FOLDER_FILE.test(path)) continue;
    try {
      const json = JSON.parse(files[path]) as { id?: unknown; duration?: unknown; fps?: unknown } | null;
      if (json && typeof json.id === 'string' && typeof json.duration === 'number' && json.duration > 0) {
        lengths.set(json.id, { duration: json.duration, ...(typeof json.fps === 'number' ? { fps: json.fps } : {}) });
      }
    } catch {
      // Reported with the file itself.
    }
  }
  /** What a folder scene is checked against: it draws, may use the cast, and places nothing. */
  const sceneContext: ProjectContext = { id: '', fps: 0, size: [0, 0], cast, scenes: lengths, kind: 'scene' };

  for (const path of Object.keys(files).sort()) {
    if (!/^\/scenes\/[^/]+\.json$/.test(path)) continue;
    const file = path.replace(/^\//, '');
    const entryErrors: string[] = [];
    let scene: Scene | null = null;
    let json: unknown;
    let parsed = false;

    try {
      json = JSON.parse(files[path]);
      parsed = true;
    } catch (err) {
      entryErrors.push(`invalid JSON: ${message(err)}`);
    }

    if (parsed) {
      try {
        const result = validate(json, registry ?? undefined, generators ?? undefined, sceneContext);
        if (result.ok) scene = result.scene;
        else entryErrors.push(...result.errors);
      } catch (err) {
        entryErrors.push(`validator threw: ${message(err)}`);
      }
    }

    const id = parsed ? declaredId(json) : null;
    let key = id ?? fileStem(path);
    const taken = byKey.get(key);
    if (taken && id !== null && fileStem(path) === id && fileStem(taken.path) !== id) {
      // Scene files are named after their id, so this file owns the id and the
      // other one is a copy that kept it. The copy gets the error, wherever it sorts.
      const copy: SceneEntry = {
        ...taken,
        key: taken.file,
        scene: null,
        errors: [...taken.errors, duplicateIdError(id, file)],
      };
      entries[entries.indexOf(taken)] = copy;
      byKey.set(copy.key, copy);
    } else if (taken) {
      if (id !== null) {
        entryErrors.push(duplicateIdError(id, taken.file));
        scene = null;
      }
      key = file;
    }

    const entry: SceneEntry = { key, path, file, scene, errors: entryErrors, project: null, registry, world: cast === EMPTY_CAST ? {} : { cast }, context: sceneContext, kind: 'scene' };
    byKey.set(key, entry);
    entries.push(entry);
  }

  if (projectTools?.validateComposition) buildCompositions(files, projectTools, registry, generators, cast, lengths, entries, byKey);

  const projects = projectTools ? buildProjects(files, validate, generators, projectTools, entries) : [];
  return { entries, projects, registry, generators, errors, folder };
}

const FOLDER_FILE = /^\/(scenes|compositions)\/[^/]+\.json$/;
const EMPTY_CAST: Cast = {};

/**
 * The folder's compositions (ADR 0013), added to `entries`. Each is checked as a composition against the
 * folder's scenes and compositions, shares ids with them, and renders as a scene whose layers are its
 * clips; a composition that places itself through others, or places one with errors, gets an error too.
 * Every scene and composition then gets the same world: the valid ones by id, and the cast.
 */
function buildCompositions(
  files: Readonly<Record<string, string>>,
  tools: ProjectTools,
  registry: RigRegistry | null,
  generators: GeneratorRegistry | null,
  cast: Cast,
  lengths: ReadonlyMap<string, { duration: number; fps?: number }>,
  entries: SceneEntry[],
  byKey: Map<string, SceneEntry>,
): void {
  const own: SceneEntry[] = [];
  for (const path of Object.keys(files).sort()) {
    if (!/^\/compositions\/[^/]+\.json$/.test(path)) continue;
    const file = path.slice(1);
    const stem = fileStem(path);
    const errors: string[] = [];
    let scene: Scene | null = null;
    try {
      const json = JSON.parse(files[path]) as unknown;
      const declared = declaredId(json);
      if (declared !== stem) errors.push(`id: must be "${stem}", the file's name, got ${declared === null ? 'none' : `"${declared}"`}`);
      const taken = byKey.get(stem);
      if (taken) errors.push(`id: "${stem}" is already ${taken.file}; a project's scenes and compositions share ids, so rename one`);
      const result = tools.validateComposition!(json, registry ?? undefined, generators ?? undefined, { id: '', cast, scenes: lengths });
      if (!result.ok) errors.push(...result.errors);
      else if (errors.length === 0) scene = result.scene;
    } catch (err) {
      errors.push(`invalid JSON: ${message(err)}`);
    }
    const context: ProjectContext = { id: '', fps: scene?.fps ?? 0, size: scene?.size ?? [0, 0], cast, scenes: lengths, kind: 'composition' };
    const entry: SceneEntry = { key: byKey.has(stem) ? file : stem, path, file, scene, errors, project: null, registry, world: {}, context, kind: 'composition' };
    own.push(entry);
    byKey.set(entry.key, entry);
  }
  entries.push(...own);

  // Loops and nesting across compositions, then compositions placing anything with errors, until nothing changes.
  const folderEntries = entries.filter((e) => e.project === null);
  const valid = () => new Map(folderEntries.filter((e) => e.scene).map((e) => [e.key, e.scene!]));
  for (const [id, graphErrors] of tools.sceneGraphErrors(valid())) {
    const entry = own.find((e) => e.key === id);
    if (entry) Object.assign(entry, { scene: null, errors: [...entry.errors, ...graphErrors.map((e) => e.replace(/^scene layers/, 'clips').replace(/a scene can't show itself/, "a composition can't show itself"))] });
  }
  for (let changed = true; changed; ) {
    changed = false;
    const ok = valid();
    for (const entry of own) {
      const broken = entry.scene?.layers.find((l) => l.scene !== undefined && !ok.has(l.scene));
      if (!broken) continue;
      Object.assign(entry, { scene: null, errors: [...entry.errors, `tracks: clip "${broken.id}" places "${broken.scene}", which has errors`] });
      changed = true;
    }
  }
  const world: World = { scenes: valid(), ...(cast === EMPTY_CAST ? {} : { cast }) };
  for (const entry of folderEntries) entry.world = world;
}

/**
 * Builds every project folder in `files`, adding its scenes to `entries`.
 * A project's scenes are checked against project.json (its fps, size and
 * cast) and against each other: a scene placing itself through others, or
 * placing a scene that has errors, gets an error of its own.
 */
function buildProjects(
  files: Readonly<Record<string, string>>,
  validate: ValidateScene,
  generators: GeneratorRegistry | null,
  tools: ProjectTools,
  entries: SceneEntry[],
): ProjectEntry[] {
  const byProject = new Map<string, string[]>();
  for (const path of Object.keys(files).sort()) {
    const where = projectPath(path);
    if (where) byProject.set(where.project, [...(byProject.get(where.project) ?? []), path]);
  }
  const out: ProjectEntry[] = [];
  for (const [id, paths] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
    const projectErrors: string[] = [];
    let registry: RigRegistry | null = null;
    try {
      registry = tools.createProjectRegistry(tools.rigs?.[id] ?? []);
    } catch (err) {
      projectErrors.push(`rigs: ${message(err)} (fix the rigs in projects/${id}/rigs/)`);
    }
    const scenePaths = paths.filter((p) => projectPath(p)!.stem !== 'project');
    const stems = scenePaths.map((p) => projectPath(p)!.stem);
    const projectFile = `/projects/${id}/project.json`;
    let project: ProjectFile | null = null;
    if (!(projectFile in files)) {
      projectErrors.push(`project.json: missing; a project folder needs one, like { "fps": 24, "size": [1920, 1080], "main": "film" }`);
    } else {
      try {
        const result = tools.validateProject(JSON.parse(files[projectFile]), registry ?? undefined, stems);
        if (result.ok) project = result.project;
        else projectErrors.push(...result.errors.map((e) => `project.json ${e}`));
      } catch (err) {
        projectErrors.push(`project.json: invalid JSON: ${message(err)}`);
      }
    }

    // Parse every scene first: each is checked against the lengths of the others.
    const parsed = new Map<string, { path: string; json: unknown } | { path: string; error: string }>();
    for (const path of scenePaths) {
      const stem = projectPath(path)!.stem;
      try {
        parsed.set(stem, { path, json: JSON.parse(files[path]) });
      } catch (err) {
        parsed.set(stem, { path, error: `invalid JSON: ${message(err)}` });
      }
    }
    const lengths = new Map<string, { duration: number }>();
    for (const [stem, p] of parsed) {
      const duration = 'json' in p ? (p.json as { duration?: unknown } | null)?.duration : undefined;
      if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) lengths.set(stem, { duration });
    }
    const context: ProjectContext | null = project
      ? { id, fps: project.fps, size: project.size, cast: project.cast ?? {}, scenes: lengths }
      : null;

    const own: SceneEntry[] = [];
    for (const [stem, p] of parsed) {
      const errors: string[] = [];
      let scene: Scene | null = null;
      if ('error' in p) errors.push(p.error);
      else if (!context) errors.push(`project.json: ${projectFile.slice(1)} has errors, so this scene can't be checked; fix it first`);
      else {
        const declared = declaredId(p.json);
        if (declared !== stem) errors.push(`id: must be "${stem}", the file's name, got ${declared === null ? 'none' : `"${declared}"`}`);
        try {
          const result = validate(p.json, registry ?? undefined, generators ?? undefined, context);
          if (result.ok) scene = errors.length === 0 ? result.scene : null;
          else errors.push(...result.errors);
        } catch (err) {
          errors.push(`validator threw: ${message(err)}`);
        }
      }
      own.push({ key: `${id}/${stem}`, path: p.path, file: p.path.slice(1), scene, errors, project: id, registry, world: {}, context, kind: 'scene' });
    }

    // Scene layers across the project: loops and depth, then scenes placing a scene with errors, until nothing changes.
    const valid = () => new Map(own.filter((e) => e.scene).map((e) => [e.key.slice(id.length + 1), e.scene!]));
    for (const [stem, graphErrors] of tools.sceneGraphErrors(valid())) {
      const entry = own.find((e) => e.key === `${id}/${stem}`)!;
      Object.assign(entry, { scene: null, errors: [...entry.errors, ...graphErrors] });
    }
    for (let changed = true; changed; ) {
      changed = false;
      const ok = valid();
      for (const entry of own) {
        const broken = entry.scene?.layers.find((l) => l.scene !== undefined && !ok.has(l.scene));
        if (!broken) continue;
        Object.assign(entry, { scene: null, errors: [...entry.errors, `layers: "${broken.id}" places scene "${broken.scene}", which has errors`] });
        changed = true;
      }
    }
    const world: World = { scenes: valid(), cast: project?.cast ?? {} };
    for (const entry of own) entry.world = world;
    entries.push(...own);
    out.push({
      id,
      name: project?.name ?? id,
      file: projectFile.slice(1),
      project,
      main: project?.main !== undefined ? `${id}/${project.main}` : null,
      errors: projectErrors,
    });
  }
  return out;
}

function duplicateIdError(id: string, owner: string): string {
  return `id: "${id}" is already used by ${owner}. Scene ids must be unique; rename one of them.`;
}

/**
 * Finds an entry by key, then by module path (keeps the selection when a scene
 * id is renamed), then by file name (?scene=probe opens scenes/probe.json
 * whatever id it declares).
 */
export function findEntry(library: SceneLibrary, key: string | null, path?: string | null): SceneEntry | null {
  if (key !== null) {
    const hit = library.entries.find((e) => e.key === key);
    if (hit) return hit;
  }
  if (path) {
    const hit = library.entries.find((e) => e.path === path);
    if (hit) return hit;
  }
  if (key !== null) {
    const hit = library.entries.find((e) => e.project === null && fileStem(e.path) === key);
    if (hit) return hit;
  }
  return null;
}

/**
 * The entry to open for ?scene=. Falls back to the first scene; `missing` is
 * true when a scene was requested and nothing matched it, so the viewer can
 * say so instead of silently showing another scene.
 */
export function openingEntry(library: SceneLibrary, requested: string | null): { entry: SceneEntry | null; missing: boolean } {
  const hit = findEntry(library, requested);
  return { entry: hit ?? library.entries[0] ?? null, missing: requested !== null && hit === null };
}
