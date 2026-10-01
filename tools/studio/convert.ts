// Converting a film made before compositions, projects/<id>/ (M9, ADR 0007),
// into a project folder of its own (ADR 0013), on request. project.json
// keeps the name, format and cast. A scene that draws stays a scene. A scene
// that places scenes becomes a composition with one track, V1, its layers
// as clips in their order; its background and each run of drawn layers
// between the scene layers become scenes of their own, placed as clips where
// they were, so every frame renders the same. The film's rigs go to rigs/,
// and the sound files its cues play to media/. Node only, used by the studio
// server, the app and the build of the sample project.

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const CLIP_FIELDS = ['id', 'scene', 'start', 'in', 'out', 'params', 'tracks', 'overrides', 'mask'];

export interface ConvertedFilm {
  project: Json;
  scenes: Record<string, Json>;
  compositions: Record<string, Json>;
  /** Sound files the cues play, relative to the folder, e.g. "media/voice.wav". */
  media: string[];
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `base`, or `base-2`, `base-3` and so on, whichever `taken` doesn't have yet; the result is added to it. */
function fresh(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The conversion itself, on the parsed files: project.json and the scenes by id. */
export function convertFilmFiles(projectJson: Json, sceneFiles: Record<string, Json>): ConvertedFilm {
  const { main: _main, ...project } = projectJson;
  const scenes: Record<string, Json> = {};
  const compositions: Record<string, Json> = {};
  const taken = new Set(Object.keys(sceneFiles));
  const media = new Set<string>();
  const cues = (s: Json) => {
    for (const cue of Array.isArray(s.audio) ? s.audio : []) if (isObject(cue) && typeof cue.file === 'string') media.add(cue.file);
  };

  for (const [id, scene] of Object.entries(sceneFiles)) {
    cues(scene);
    const layers = Array.isArray(scene.layers) ? scene.layers.filter(isObject) : [];
    if (!layers.some((l) => typeof l.scene === 'string')) {
      scenes[id] = scene;
      continue;
    }
    // The format and seed the scenes cut from it keep, so their rigs draw the same.
    const format = { fps: scene.fps, duration: scene.duration, size: scene.size, ...(scene.seed !== undefined ? { seed: scene.seed } : {}) };
    // The scene layers keep their ids as clips; "background" is the engine's, so the backdrop takes another.
    const clipIds = new Set(['background', ...layers.filter((l) => typeof l.scene === 'string').map((l) => String(l.id))]);
    const clips: Json[] = [];
    const cut = (suffix: string, clipBase: string, body: Json) => {
      const sceneId = fresh(`${id}-${suffix}`, taken);
      scenes[sceneId] = { id: sceneId, ...format, ...body };
      clips.push({ id: fresh(clipBase, clipIds), scene: sceneId, start: 0 });
    };
    let run: Json[] = [];
    const flush = () => {
      if (run.length === 0) return;
      cut(String(run[0].id), String(run[0].id), { layers: run });
      run = [];
    };
    if (scene.background !== undefined) cut('background', 'backdrop', { background: scene.background, layers: [] });
    for (const layer of layers) {
      if (typeof layer.scene !== 'string') {
        run.push(layer);
        continue;
      }
      flush();
      clips.push(Object.fromEntries(Object.entries(layer).filter(([k]) => CLIP_FIELDS.includes(k))));
    }
    flush();
    compositions[id] = {
      id,
      fps: scene.fps,
      duration: scene.duration,
      size: scene.size,
      ...(scene.seed !== undefined ? { seed: scene.seed } : {}),
      tracks: [{ id: 'V1', clips }],
      ...(scene.audio !== undefined ? { audio: scene.audio } : {}),
    };
  }
  return { project, scenes, compositions, media: [...media].sort() };
}

async function isEmpty(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => null);
  return names === null || names.every((n) => n.startsWith('.'));
}

const write = (path: string, json: unknown) => writeFile(path, `${JSON.stringify(json, null, 2)}\n`);

/**
 * Converts the film in `source` (a projects/<id>/ folder) into a new project folder at `to`, which must be
 * missing or empty. `media` is the folder its sound files are relative to, the studio folder it was in.
 * Returns what it wrote.
 */
export async function convertFilm(source: string, to: string, media: string): Promise<ConvertedFilm> {
  if (!(await isEmpty(to))) throw new Error(`${to} already has files in it, so the film can't be converted there.`);
  const names = await readdir(source).catch(() => null);
  if (!names) throw new Error(`There is no film at ${source}.`);
  const projectJson = JSON.parse(await readFile(join(source, 'project.json'), 'utf8')) as unknown;
  if (!isObject(projectJson)) throw new Error(`${join(source, 'project.json')} isn't a JSON object.`);
  const sceneFiles: Record<string, Json> = {};
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'project.json').sort()) {
    const json = JSON.parse(await readFile(join(source, name), 'utf8')) as unknown;
    if (!isObject(json)) throw new Error(`${join(source, name)} isn't a JSON object.`);
    sceneFiles[name.slice(0, -'.json'.length)] = json;
  }
  const film = convertFilmFiles(projectJson, sceneFiles);

  for (const dir of ['scenes', 'compositions', 'rigs', 'audio', 'media']) await mkdir(join(to, dir), { recursive: true });
  await write(join(to, 'project.json'), film.project);
  for (const [id, scene] of Object.entries(film.scenes)) await write(join(to, 'scenes', `${id}.json`), scene);
  for (const [id, composition] of Object.entries(film.compositions)) await write(join(to, 'compositions', `${id}.json`), composition);
  if (await stat(join(source, 'rigs')).catch(() => null)) await cp(join(source, 'rigs'), join(to, 'rigs'), { recursive: true });
  for (const file of film.media) {
    if (await stat(join(media, file)).catch(() => null)) await cp(join(media, file), join(to, file));
  }
  return film;
}
