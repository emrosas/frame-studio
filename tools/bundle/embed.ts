// Builds the single-file HTML embed for a scene (M4): the engine, the embed
// player, only the rigs the scene draws with, the scene data and, for a scene
// with audio, only the generators it uses (M7), bundled and minified into one
// inline script. A project scene also carries the scenes it places, however
// deep, its project's cast, and the project rigs they draw with (ADR 0007).
// The file makes no requests and needs no runtime library.
//
// Text (ADR 0010): the text rig's typefaces are cut to the typefaces and
// characters the scene's strings use, so an embed carries only those glyphs.
//
// Scenes are validated here, at export time, so the embed ships without the
// validator. Scene keys resolve exactly as in the viewer and render page
// (buildLibrary and findEntry). Rolldown bundles it, on its own, so the app
// needs no Vite (ADR 0008); it reads the built-ins and the folder's rigs from
// disk. Node only; runs as TypeScript through Node's type stripping.

import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { rolldown, type Plugin } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { transformSync } from 'rolldown/utils';
import type { Scene, World } from '../../src/engine/types.ts';
import type { Typeface } from '../../src/rigs/type/typeface.ts';
import { loadModules, sceneLibrary } from '../scene-files.ts';
import type { CodeHost } from '../studio/code.ts';
import type { StudioFolder } from '../studio/folder.ts';
import { collectStrings, typefacesFor } from '../type/subset.ts';

export interface EmbedBuild {
  html: string;
  scene: Scene;
  /** The folder under out/ the scene's files go to: its id, or "<project>/<id>". */
  out: string;
  /** Ids of the scenes it places, however deep, sorted. Empty for a loose scene. */
  scenes: string[];
  /** Rig ids bundled, sorted. */
  rigs: string[];
  /** Audio generator ids bundled, sorted. Empty for a silent scene or a silent export. */
  generators: string[];
  bytes: {
    /** The whole HTML file. */
    total: number;
    /** The inline script. */
    script: number;
    /**
     * The engine and player alone, minified: what every embed pays before rigs
     * and scene data. Only measured with measureRuntime, since it costs a second build.
     */
    runtime?: number;
  };
}

export interface EmbedBuildOptions {
  /** The studio folder, and the code host that has its rigs and generators. */
  folder: StudioFolder;
  code: CodeHost;
  /** Also bundle the engine and player alone to report bytes.runtime. */
  measureRuntime?: boolean;
  /** Leave the scene's audio out. */
  silent?: boolean;
}

const ENTRY = 'virtual:frame-studio-embed';

function entryPlugin(code: string): Plugin {
  return {
    name: 'frame-studio-embed-entry',
    // Library mode resolves the entry against the root, so match the end of the id.
    resolveId: (id) => (id === ENTRY || id.endsWith(`/${ENTRY}`) ? `\0${ENTRY}` : null),
    load: (id) => (id === `\0${ENTRY}` ? code : null),
  };
}

/** Schema helpers in src/rigs/parts/params.ts, by arity; their last argument is the description. */
const SCHEMA_HELPERS: Record<string, number> = { num: 4, col: 2, choice: 3 };

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

/** Plain text: a string literal, a template literal with nothing interpolated, or texts joined with +. */
function isText(node: unknown): node is Node {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'BinaryExpression') return node.operator === '+' && isText(node.left) && isText(node.right);
  return node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (isNode(node)) {
    visit(node);
    for (const [k, v] of Object.entries(node)) if (k !== 'type' && typeof v === 'object') walk(v, visit);
  }
}

/**
 * Empties the description text in rig and generator modules: every
 * string-valued `description` property, and the description argument of the
 * schema helpers. Descriptions document params for people and agents
 * (list_rigs, docs); the player never reads them. About 13% of the bear-test
 * embed. Exported for tests.
 */
export function stripDescriptions(code: string): string {
  const cuts: [number, number][] = [];
  walk(parseAst(code), (n) => {
    if (n.type === 'Property' && !n.computed) {
      const key = n.key as Node;
      const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
      if (name === 'description' && isText(n.value)) cuts.push([(n.value as Node).start, (n.value as Node).end]);
    } else if (n.type === 'CallExpression') {
      const callee = n.callee as Node;
      const args = n.arguments as unknown[];
      const last = args.at(-1);
      if (callee.type === 'Identifier' && SCHEMA_HELPERS[callee.name as string] === args.length && isText(last)) cuts.push([last.start, last.end]);
    }
  });
  let out = code;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, start)}''${out.slice(end)}`;
  return out;
}

/** Strips descriptions from rig and generator modules: the built-ins', the studio folder's and the projects'. */
function stripDescriptionsPlugin(folder: StudioFolder): Plugin {
  const code = (id: string) => {
    const b = relative(folder.builtins, id).split(sep).join('/');
    if (/^(rigs|audio)\//.test(b)) return true;
    const f = relative(folder.root, id).split(sep).join('/');
    return /^(rigs|audio)\//.test(f) || /^projects\/[^/]+\/rigs\//.test(f);
  };
  return {
    name: 'frame-studio-strip-descriptions',
    transform(source, id) {
      if (!id.endsWith('.ts') || !code(id)) return null;
      // Rolldown hands plugins TypeScript; turn it into JavaScript first, so the parser sees plain JavaScript.
      const js = transformSync(id, source, { lang: 'ts', target: 'es2022' });
      if (js.errors.length > 0) return null;
      return { code: stripDescriptions(js.code), moduleType: 'js', map: null };
    },
  };
}

const FACES = 'rigs/type/faces/index.ts';

/**
 * Swaps the built-in typeface index for one with only the typefaces and
 * characters in `data`'s strings, when the text rig is bundled. A rig of the
 * folder's that imports the type modules itself may draw text from its own
 * code, which the scene's strings don't show, so then the typefaces go in whole.
 */
async function typefacePlugin(files: readonly string[], folder: StudioFolder, code: CodeHost, data: unknown): Promise<Plugin | null> {
  const textRig = join(folder.builtins, 'rigs/type/text.ts');
  if (!files.includes(textRig)) return null;
  for (const file of files) if (file !== textRig && /rigs\/type\//.test(await readFile(file, 'utf8'))) return null;
  const all = (await code.importBuiltin(FACES)).typefaces as readonly Typeface[];
  const source = `export const typefaces = ${JSON.stringify(typefacesFor(all, collectStrings(data))).replace(/</g, '\\u003c')};`;
  const path = join(folder.builtins, FACES);
  return { name: 'frame-studio-typefaces', load: (id) => (id === path ? source : null) };
}

/** Bundles `code` as a minified IIFE and returns its text. */
async function bundle(code: string, folder: StudioFolder, extra: Plugin | null = null): Promise<string> {
  const build = await rolldown({
    input: ENTRY,
    platform: 'browser',
    logLevel: 'silent',
    plugins: [entryPlugin(code), ...(extra ? [extra] : []), stripDescriptionsPlugin(folder)],
    resolve: { alias: { '@frame-studio': folder.builtins } },
  });
  try {
    const { output } = await build.generate({ format: 'iife', name: 'frameStudioEmbed', minify: true, legalComments: 'none' });
    const chunks = output.filter((o) => o.type === 'chunk');
    if (chunks.length !== 1) throw new Error(`expected one bundled chunk, got ${chunks.length}`);
    return chunks[0].code;
  } finally {
    await build.close();
  }
}

const importPath = (file: string) => JSON.stringify(file);

/**
 * Makes bundled code safe inside an inline <script>. The page's HTML parser
 * ends the script at the first "</script", even inside a JS string, and a
 * "<!--" followed by "<script" changes where it ends. "</" becomes "<\/",
 * which means the same in strings, templates and regexes. Scene data never
 * gets here with a "<" in it (see sceneLiteral), so any "<!--" or "<script"
 * left is in our own code, and the build stops rather than guess.
 */
export function inlineSafe(js: string): string {
  const safe = js.replace(/<\/(script)/gi, '<\\/$1');
  const risky = /<!--|<script/i.exec(safe);
  if (risky) throw new Error(`the bundled script contains "${risky[0]}", which would break the inline <script>; remove it from the source`);
  return safe;
}

/** The scene (or any JSON data) as a JSON.parse call on a string with every "<" escaped, so user text cannot close the script. */
export function sceneLiteral(scene: unknown): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(scene).replace(/</g, '\\u003c'))})`;
}

/** True when a layer (or a background) of any of `scenes` uses cast member `name`. */
function usesCast(name: string, scenes: readonly Scene[]): boolean {
  return scenes.some((s) => s.background?.cast === name || s.layers.some((l) => l.cast === name));
}

/** Every scene `scene` places through scene layers, however deep, by id. */
function placedScenes(scene: Scene, world: World): Map<string, Scene> {
  const out = new Map<string, Scene>();
  const visit = (s: Scene) => {
    for (const layer of s.layers) {
      const shot = layer.scene !== undefined ? world.scenes?.get(layer.scene) : undefined;
      if (!shot || out.has(layer.scene!)) continue;
      out.set(layer.scene!, shot);
      visit(shot);
    }
  };
  visit(scene);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function page(scene: Scene, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Frame Studio">
<title>${escapeHtml(scene.id)}</title>
<style>
html, body { margin: 0; height: 100%; background: transparent; }
#frame-studio { width: 100%; height: 100%; }
#frame-studio canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
#frame-studio pre { margin: 1em; font: 12px/1.4 monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="frame-studio"></div>
<script>${script}</script>
</body>
</html>
`;
}

export async function buildEmbed(sceneKey: string, options: EmbedBuildOptions): Promise<EmbedBuild> {
  const { folder } = options;
  const modules = await loadModules(options.code);
  const { engine } = modules;
  const lib = await sceneLibrary(modules, folder);
  const entry = modules.library.findEntry(lib, sceneKey);
  if (!entry) throw new Error(`No scene "${sceneKey}". Scenes: ${lib.entries.map((e) => e.key).join(', ')}`);
  const project = entry.project !== null ? lib.projects.find((p) => p.id === entry.project) : undefined;
  const problems = [...lib.errors, ...entry.errors, ...(project?.errors ?? []).map((e) => `${project!.file}: ${e}`)];
  if (!entry.scene || problems.length > 0) throw new Error(`${entry.file} has errors, so it cannot be exported:\n${problems.join('\n')}`);
  // A silent export drops the cues, the placed scenes' too, so the embed carries no audio code at all.
  const quiet = (s: Scene): Scene => (options.silent ? { ...s, audio: undefined } : s);
  const scene = quiet(entry.scene);
  const placed = new Map([...placedScenes(entry.scene, entry.world)].map(([id, s]) => [id, quiet(s)] as const));
  const world: World = { scenes: placed, cast: entry.world.cast };
  const ids = engine.rigIdsUsed(scene, world);
  const rigFiles = new Map(modules.rigDefinitions);
  if (project) for (const [id, file] of modules.projectRigDefinitions[project.id] ?? []) rigFiles.set(id, file);
  const where = project ? `the built-in rigs, rigs/ or projects/${project.id}/rigs/` : 'the built-in rigs or rigs/';
  const missing = ids.filter((id) => !rigFiles.has(id));
  if (missing.length > 0) throw new Error(`No module in ${where} exports rig ${missing.map((m) => `"${m}"`).join(', ')} by name.`);
  const generatorIds = [...new Set([scene, ...placed.values()].flatMap((s) => (s.audio ?? []).map((cue) => cue.generator)))].sort();
  const generatorFiles = modules.generatorDefinitions;
  const missingGenerators = generatorIds.filter((id) => !generatorFiles.has(id));
  if (missingGenerators.length > 0) {
    throw new Error(`No module in the built-in generators or audio/ exports generator ${missingGenerators.map((m) => `"${m}"`).join(', ')} by name.`);
  }

  const player = join(folder.builtins, 'embed/player.ts');
  const imports = [
    ...ids.map((id, i) => `import { ${rigFiles.get(id)!.name} as rig${i} } from ${importPath(rigFiles.get(id)!.file)};`),
    ...generatorIds.map((id, i) => `import { ${generatorFiles.get(id)!.name} as gen${i} } from ${importPath(generatorFiles.get(id)!.file)};`),
  ];
  const sound = generatorIds.length > 0 ? `embedSound([${generatorIds.map((_, i) => `gen${i}`).join(', ')}])` : 'undefined';
  const cast = Object.fromEntries(Object.entries(entry.world.cast ?? {}).filter(([name]) => usesCast(name, [scene, ...placed.values()])));
  const bundled = project ? { scenes: Object.fromEntries([...placed].sort(([a], [b]) => a.localeCompare(b))), cast } : null;
  const code = [
    `import { mountEmbed, optionsFromQuery } from ${importPath(player)};`,
    ...(generatorIds.length > 0 ? [`import { embedSound } from ${importPath(join(folder.builtins, 'embed/sound.ts'))};`] : []),
    ...imports,
    `const scene = ${sceneLiteral(scene)};`,
    `window.studio = mountEmbed(document.getElementById('frame-studio'), scene, [${ids.map((_, i) => `rig${i}`).join(', ')}], optionsFromQuery(location.search), ${sound}${bundled ? `, ${sceneLiteral(bundled)}` : ''});`,
  ].join('\n');
  const runtimeOnly = `import { mountEmbed, optionsFromQuery } from ${importPath(player)};\nwindow.studio = [mountEmbed, optionsFromQuery];`;

  const faces = await typefacePlugin(
    ids.map((id) => rigFiles.get(id)!.file),
    folder,
    options.code,
    [scene, ...placed.values(), cast],
  );
  const script = inlineSafe(await bundle(code, folder, faces));
  const html = page(scene, script);
  const runtime = options.measureRuntime ? Buffer.byteLength(await bundle(runtimeOnly, folder)) : undefined;
  return {
    html,
    scene,
    out: project ? `${project.id}/${scene.id}` : scene.id,
    scenes: [...placed.keys()].sort(),
    rigs: ids,
    generators: generatorIds,
    bytes: { total: Buffer.byteLength(html), script: Buffer.byteLength(script), runtime },
  };
}
