// What an agent in the studio may do without asking (ADR 0006). In the
// default access it may read the studio folder, use the studio tools on its
// own scene, and write in scenes/, compositions/, rigs/, audio/, project.json
// and M9 projects' rigs/, and in a repo in src/rigs/ and src/audio/, the
// built-ins (ADR 0008, ADR 0013).
// Everything else asks the user first. Full access asks for nothing. In
// either mode, a scene another thread is working on is off limits, since both
// would write it, and an edit to a project's project.json, which touches
// every scene in it, waits until no other thread in the project works
// (ADR 0007).
//
// These rules keep a well-meaning agent inside the lines; they are not a
// sandbox. Rig and generator code the agent writes runs in the studio
// server's Node process and in the browser, so an agent that means harm can
// still get out through it. Pure, so it is unit tested. Node only.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { projectOf, type AccessMode } from '../../../src/studio/protocol.ts';
import type { Action } from './types.ts';

export type Verdict =
  | { allow: true }
  | { allow: false; ask: true; summary: string; detail?: string }
  /** Refused. With wait, only for now: asking again once other work ends may allow it. */
  | { allow: false; ask: false; reason: string; wait?: true };

export interface AccessContext {
  access: AccessMode;
  /** The repo root. */
  root: string;
  /** The scene this thread is on. */
  sceneId: string;
  /** Other threads' scenes with a turn working right now, by qualified id. */
  busyScenes: readonly string[];
  /** Base rig ids ("bear" for "bear.blush") that the busy scenes draw with. */
  busyRigs: readonly string[];
}

const WRITABLE = ['scenes', 'compositions', 'rigs', 'audio', 'src/rigs', 'src/audio'];
/**
 * The folder's project.json (ADR 0013), and an M9 project's rigs and files: a project scene's file or
 * project.json, judged as scene or project edits first.
 */
const PROJECT_WRITABLE = /^(project\.json$|projects\/[^/]+\/(rigs(\/|$)|[^/]+\.json$))/;

/** The path relative to the repo, or null when it is outside it. */
function inRepo(root: string, path: string): string | null {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

/** A rig file that a busy scene may draw with: named after one of its rigs, or a shared part. Global or a project's. */
function busyRigFile(rel: string, busyRigs: readonly string[]): boolean {
  const dir = /^(src\/rigs|rigs|projects\/[^/]+\/rigs)\//.exec(rel)?.[0];
  if (!dir) return false;
  if (rel.startsWith(`${dir}parts/`)) return busyRigs.length > 0;
  const name = rel.slice(dir.length).split('/').pop() ?? '';
  return busyRigs.some((rig) => name === `${rig}.ts` || name.startsWith(`${rig}-`) || name.startsWith(`${rig}.`));
}

/** What editing a file under the repo means for the scenes: another scene, a project.json, or nothing special. */
function fileAction(rel: string, tool: string): Action | null {
  const loose = /^(?:scenes|compositions)\/([^/]+)\.json$/.exec(rel);
  if (loose) return { kind: 'scene', sceneId: loose[1], tool };
  const inProject = /^projects\/([^/]+)\/([^/]+)\.json$/.exec(rel);
  if (!inProject) return null;
  return inProject[2] === 'project' ? { kind: 'project', projectId: inProject[1], tool } : { kind: 'scene', sceneId: `${inProject[1]}/${inProject[2]}`, tool };
}

export function judge(action: Action, ctx: AccessContext): Verdict {
  if (action.kind === 'project') {
    const busy = ctx.busyScenes.filter((id) => projectOf(id) === action.projectId);
    if (busy.length > 0) {
      return {
        allow: false,
        ask: false,
        wait: true,
        reason: `Changing project "${action.projectId}" touches every scene in it, so it waits until no other request there is working; ${busy.map((id) => `"${id}"`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working.`,
      };
    }
    if (ctx.access === 'full' || projectOf(ctx.sceneId) === action.projectId) return { allow: true };
    return { allow: false, ask: true, summary: `Change project "${action.projectId}" with ${action.tool}`, detail: `This request is about "${ctx.sceneId}".` };
  }
  if (action.kind === 'scene') {
    if (ctx.busyScenes.includes(action.sceneId)) {
      return { allow: false, ask: false, reason: `Another request is working on scene "${action.sceneId}" right now; edit only "${ctx.sceneId}", or try again once that request's turn ends.` };
    }
    if (ctx.access === 'full') return { allow: true };
    return { allow: false, ask: true, summary: `Change scene "${action.sceneId}" with ${action.tool}`, detail: `This request is about "${ctx.sceneId}".` };
  }
  if (action.kind === 'write') {
    const rels = action.paths.map((p) => ({ path: p, rel: inRepo(ctx.root, p) }));
    // A scene file is named after its scene, so editing another scene's file is editing that scene,
    // and editing project.json is editing the project.
    for (const { rel } of rels) {
      const meant = rel ? fileAction(rel, `an edit to ${rel}`) : null;
      if (meant && !(meant.kind === 'scene' && meant.sceneId === ctx.sceneId)) {
        const verdict = judge(meant, ctx);
        if (!verdict.allow) return verdict;
      }
    }
    const busy = rels.filter(({ rel }) => rel !== null && busyRigFile(rel, ctx.busyRigs));
    if (ctx.access === 'full' && busy.length === 0) return { allow: true };
    const outside = rels.filter(({ rel }) => rel === null || !(WRITABLE.some((dir) => rel === dir || rel.startsWith(`${dir}/`)) || PROJECT_WRITABLE.test(rel)));
    if (outside.length === 0 && busy.length === 0) return { allow: true };
    const names = rels.map(({ path, rel }) => rel ?? path).join(', ');
    if (busy.length > 0) {
      return { allow: false, ask: true, summary: `Edit ${names}`, detail: 'Another request is working on a scene that may draw with this rig.' };
    }
    return { allow: false, ask: true, summary: `Edit ${names}`, detail: 'Outside scenes/, compositions/, rigs/, audio/ and project.json.' };
  }
  if (ctx.access === 'full') return { allow: true };
  switch (action.kind) {
    case 'read':
      return inRepo(ctx.root, action.path) !== null ? { allow: true } : { allow: false, ask: true, summary: `Read ${action.path}`, detail: 'Outside the project.' };
    case 'command':
      return { allow: false, ask: true, summary: 'Run a command', detail: action.command };
    case 'network':
      return { allow: false, ask: true, summary: `Go online: ${action.target}` };
    case 'tool':
      return { allow: false, ask: true, summary: `Use ${action.name}`, ...(action.detail ? { detail: action.detail } : {}) };
  }
}
