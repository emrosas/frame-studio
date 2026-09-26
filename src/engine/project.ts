// Projects (ADR 0007): project.json and the checks that span its scenes. A
// scene is still validated on its own by validateScene, given the project as
// context; this checks the project file itself, and that scene layers never
// place a scene inside itself, however indirectly.

import { MAX_SCENE_DEPTH } from './scene-layer';
import type { Cast, Params, RigRegistry, Scene } from './types';
import { validateScene } from './validate';

/** projects/<id>/project.json. */
export interface ProjectFile {
  /** Shown in the viewer; the folder name is the id. */
  name?: string;
  fps: number;
  size: [number, number];
  /** The scene that places the shots; exporting it exports the whole video. */
  main?: string;
  cast?: Cast;
}

export type ProjectValidation = { ok: true; project: ProjectFile } | { ok: false; errors: string[] };

const PROJECT_FIELDS = new Set(['name', 'fps', 'size', 'main', 'cast']);
const CAST_FIELDS = new Set(['rig', 'params']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'nothing' : JSON.stringify(v));

/**
 * Checks project.json. With a registry, cast members must name registered
 * rigs with params their rigs take; with the project's scene ids, main must
 * be one of them. Errors read "path: message", like validateScene's.
 */
export function validateProject(input: unknown, registry?: RigRegistry, sceneIds?: readonly string[]): ProjectValidation {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`);
  if (!isObject(input)) return { ok: false, errors: [`project: must be an object like { "fps": 24, "size": [1920, 1080], "main": "film" }, got ${show(input)}`] };
  for (const key of Object.keys(input)) if (!PROJECT_FIELDS.has(key)) err(key, `unknown field "${key}"; allowed fields: ${[...PROJECT_FIELDS].join(', ')}`);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) err('name', `must be a name to show, got ${show(input.name)}`);
  const fps = input.fps;
  if (!(typeof fps === 'number' && Number.isInteger(fps) && fps > 0)) err('fps', `must be a positive integer, shared by every scene in the project, got ${show(fps)}`);
  const size = input.size;
  if (!(Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0))) {
    err('size', `must be [width, height] in scene pixels, shared by every scene in the project, got ${show(size)}`);
  }
  if (input.main !== undefined) {
    if (typeof input.main !== 'string' || !input.main) err('main', `must be the id of the scene that places the shots, got ${show(input.main)}`);
    else if (sceneIds && !sceneIds.includes(input.main)) {
      err('main', `no scene "${input.main}" in the project; its scenes are ${sceneIds.length ? sceneIds.join(', ') : 'none yet'}`);
    }
  }
  if (input.cast !== undefined) {
    if (!isObject(input.cast)) err('cast', `must map names to { "rig": "...", "params": {...} }, got ${show(input.cast)}`);
    else for (const [name, member] of Object.entries(input.cast)) checkMember(name, member, registry, err);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, project: input as unknown as ProjectFile };
}

/** A cast member is checked the way a layer drawing its rig would be. */
function checkMember(name: string, member: unknown, registry: RigRegistry | undefined, err: (path: string, message: string) => void): void {
  const path = `cast.${name}`;
  if (name.includes('/') || !name.trim()) err(path, 'cast names are short names without "/"');
  if (!isObject(member)) {
    err(path, `must be { "rig": "...", "params": {...} }, got ${show(member)}`);
    return;
  }
  for (const key of Object.keys(member)) if (!CAST_FIELDS.has(key)) err(`${path}.${key}`, `unknown field "${key}"; allowed fields: rig, params`);
  if (typeof member.rig !== 'string' || !member.rig) {
    err(`${path}.rig`, `must be a rig id, got ${show(member.rig)}`);
    return;
  }
  if (!registry) return;
  // A one-layer scene drawing the member checks the rig and its params with the scene validator's own rules.
  const probe = { id: 'cast', fps: 1, duration: 1, size: [1, 1], seed: 0, layers: [{ id: 'member', rig: member.rig, params: (member.params ?? {}) as Params }] };
  const result = validateScene(probe, registry);
  if (!result.ok) for (const e of result.errors) err(path, e.replace(/^layers\[0\]\.?/, '').replace(/^: /, ''));
}

/**
 * Scene-layer problems that span scenes: a scene that places itself through
 * others, and nesting deeper than MAX_SCENE_DEPTH. Returns errors by the id of
 * each scene involved.
 */
export function sceneGraphErrors(scenes: ReadonlyMap<string, Scene>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, message: string) => out.set(id, [...(out.get(id) ?? []), message]);
  const placed = (scene: Scene) => scene.layers.flatMap((l) => (l.scene !== undefined && scenes.has(l.scene) ? [l.scene] : []));
  const depthOf = new Map<string, number>();
  const visiting: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string): number => {
    const known = depthOf.get(id);
    if (known !== undefined) return known;
    const at = visiting.indexOf(id);
    if (at >= 0) {
      const loop = [...visiting.slice(at), id];
      const key = [...loop].sort().join(',');
      if (!reported.has(key)) {
        reported.add(key);
        for (const member of new Set(loop)) add(member, `scene layers place scenes in a loop: ${loop.join(' → ')}; a scene can't show itself`);
      }
      return Infinity;
    }
    visiting.push(id);
    let depth = 0;
    for (const child of placed(scenes.get(id)!)) depth = Math.max(depth, 1 + visit(child));
    visiting.pop();
    depthOf.set(id, depth);
    return depth;
  };
  for (const id of scenes.keys()) {
    const depth = visit(id);
    if (Number.isFinite(depth) && depth > MAX_SCENE_DEPTH) {
      add(id, `places scenes ${depth} deep; nesting is limited to ${MAX_SCENE_DEPTH}`);
    }
  }
  return out;
}
