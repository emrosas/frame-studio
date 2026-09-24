// Builds the single-file HTML embed for a scene (M4): the engine, the embed
// player, only the rigs the scene draws with, the scene data and, for a scene
// with audio, only the generators it uses (M7), bundled and minified into one
// inline script. The file makes no requests and needs no runtime library.
//
// Scenes are validated here, at export time, so the embed ships without the
// validator. Scene keys resolve exactly as in the viewer and render page
// (buildLibrary and findEntry). Node only; runs as TypeScript through Node's
// type stripping.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build, createServer, parseAst, type Plugin, type Rollup, type ViteDevServer } from 'vite';
import type { AudioGenerator } from '../../src/audio/types.ts';
import type { Rig, Scene } from '../../src/engine/types.ts';
import { loadModules, ROOT, sceneLibrary } from '../scene-files.ts';

export { ROOT };

export interface EmbedBuild {
  html: string;
  scene: Scene;
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
  /** Folder of scene files. Defaults to scenes/. */
  scenesDir?: string;
  /** Also bundle the engine and player alone to report bytes.runtime. */
  measureRuntime?: boolean;
  /** A Vite server to load modules through, such as the MCP workspace's; the caller closes it. Otherwise one is started and closed. */
  server?: ViteDevServer;
  /** Leave the scene's audio out. */
  silent?: boolean;
}


const ENTRY = 'virtual:frame-studio-embed';

function isRig(value: unknown): value is Rig {
  const v = value as Partial<Rig> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.draw === 'function' && typeof v.params === 'object';
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') out.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}

function isGenerator(value: unknown): value is AudioGenerator {
  const v = value as Partial<AudioGenerator> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.schedule === 'function' && typeof v.params === 'object';
}

/**
 * Where each rig or generator is defined: its id to the module and export
 * name, found by loading every module under `dir`. A module that only
 * re-exports them (an index) loses to the one that defines them.
 */
async function definitions(
  server: ViteDevServer,
  dir: string,
  matches: (value: unknown) => value is { id: string },
): Promise<Map<string, { file: string; name: string }>> {
  const found = new Map<string, { file: string; name: string; index: boolean }>();
  for (const file of await sourceFiles(join(ROOT, dir))) {
    const mod = (await server.ssrLoadModule(file)) as Record<string, unknown>;
    const index = file.endsWith('/index.ts');
    for (const [name, value] of Object.entries(mod)) {
      if (!matches(value)) continue;
      const prev = found.get(value.id);
      if (!prev || (prev.index && !index)) found.set(value.id, { file, name, index });
    }
  }
  return new Map([...found].map(([id, { file, name }]) => [id, { file, name }]));
}


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

function stripDescriptionsPlugin(): Plugin {
  return {
    name: 'frame-studio-strip-descriptions',
    // After the TypeScript transform, so the parser sees plain JavaScript.
    enforce: 'post',
    transform: (code, id) =>
      id.startsWith(join(ROOT, 'src/rigs/')) || id.startsWith(join(ROOT, 'src/audio/')) ? { code: stripDescriptions(code), map: null } : null,
  };
}

/** Bundles `code` as a minified IIFE and returns its text. */
async function bundle(code: string): Promise<string> {
  const output = (await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    publicDir: false,
    plugins: [entryPlugin(code), stripDescriptionsPlugin()],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: ENTRY, formats: ['iife'], name: 'frameStudioEmbed', fileName: 'embed' },
    },
  })) as Rollup.RollupOutput[] | Rollup.RollupOutput;
  const outputs = Array.isArray(output) ? output : [output];
  const chunks = outputs.flatMap((o) => o.output).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (chunks.length !== 1) throw new Error(`expected one bundled chunk, got ${chunks.length}`);
  return chunks[0].code;
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

/** The scene as a JSON.parse call on a string with every "<" escaped, so user text cannot close the script. */
export function sceneLiteral(scene: Scene): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(scene).replace(/</g, '\\u003c'))})`;
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

export async function buildEmbed(sceneKey: string, options: EmbedBuildOptions = {}): Promise<EmbedBuild> {
  const server =
    options.server ??
    (await createServer({
      configFile: false,
      root: ROOT,
      logLevel: 'error',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    }));
  try {
    const modules = await loadModules(server);
    const { engine } = modules;
    const lib = await sceneLibrary(modules, options.scenesDir);
    const entry = modules.library.findEntry(lib, sceneKey);
    if (!entry) throw new Error(`No scene "${sceneKey}" in scenes/. Scenes: ${lib.entries.map((e) => e.key).join(', ')}`);
    const problems = [...lib.errors, ...entry.errors];
    if (!entry.scene || problems.length > 0) throw new Error(`${entry.file} has errors, so it cannot be exported:\n${problems.join('\n')}`);
    // A silent export drops the cues, so the embed carries no audio code at all.
    const scene: Scene = options.silent ? { ...entry.scene, audio: undefined } : entry.scene;
    const ids = engine.rigIdsUsed(scene);
    const rigFiles = await definitions(server, 'src/rigs', isRig);
    const missing = ids.filter((id) => !rigFiles.has(id));
    if (missing.length > 0) throw new Error(`No module under src/rigs exports rig ${missing.map((m) => `"${m}"`).join(', ')} by name.`);
    const generatorIds = [...new Set((scene.audio ?? []).map((cue) => cue.generator))].sort();
    const generatorFiles = generatorIds.length > 0 ? await definitions(server, 'src/audio', isGenerator) : new Map();
    const missingGenerators = generatorIds.filter((id) => !generatorFiles.has(id));
    if (missingGenerators.length > 0) {
      throw new Error(`No module under src/audio exports generator ${missingGenerators.map((m) => `"${m}"`).join(', ')} by name.`);
    }

    const player = join(ROOT, 'src/embed/player.ts');
    const imports = [
      ...ids.map((id, i) => `import { ${rigFiles.get(id)!.name} as rig${i} } from ${importPath(rigFiles.get(id)!.file)};`),
      ...generatorIds.map((id, i) => `import { ${generatorFiles.get(id)!.name} as gen${i} } from ${importPath(generatorFiles.get(id)!.file)};`),
    ];
    const sound = generatorIds.length > 0 ? `embedSound([${generatorIds.map((_, i) => `gen${i}`).join(', ')}])` : 'undefined';
    const code = [
      `import { mountEmbed, optionsFromQuery } from ${importPath(player)};`,
      ...(generatorIds.length > 0 ? [`import { embedSound } from ${importPath(join(ROOT, 'src/embed/sound.ts'))};`] : []),
      ...imports,
      `const scene = ${sceneLiteral(scene)};`,
      `window.studio = mountEmbed(document.getElementById('frame-studio'), scene, [${ids.map((_, i) => `rig${i}`).join(', ')}], optionsFromQuery(location.search), ${sound});`,
    ].join('\n');
    const runtimeOnly = `import { mountEmbed, optionsFromQuery } from ${importPath(player)};\nwindow.studio = [mountEmbed, optionsFromQuery];`;

    const script = inlineSafe(await bundle(code));
    const html = page(scene, script);
    const runtime = options.measureRuntime ? Buffer.byteLength(await bundle(runtimeOnly)) : undefined;
    return {
      html,
      scene,
      rigs: ids,
      generators: generatorIds,
      bytes: { total: Buffer.byteLength(html), script: Buffer.byteLength(script), runtime },
    };
  } finally {
    if (!options.server) await server.close();
  }
}
