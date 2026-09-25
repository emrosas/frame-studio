// What an agent in the studio may do without asking (ADR 0006). In the
// default access it may read the repo, use the studio tools on its own
// scene, and write in scenes/, src/rigs/ and src/audio/. Everything else asks
// the user first. Full access asks for nothing. In either mode, a scene
// another thread is working on is off limits, since both would write it.
//
// These rules keep a well-meaning agent inside the lines; they are not a
// sandbox. Rig and generator code the agent writes runs in the studio
// server's Node process and in the browser, so an agent that means harm can
// still get out through it. Pure, so it is unit tested. Node only.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AccessMode } from '../../../src/studio/protocol.ts';
import type { Action } from './types.ts';

export type Verdict = { allow: true } | { allow: false; ask: true; summary: string; detail?: string } | { allow: false; ask: false; reason: string };

export interface AccessContext {
  access: AccessMode;
  /** The repo root. */
  root: string;
  /** The scene this thread is on. */
  sceneId: string;
  /** Other threads' scenes with a turn working right now. */
  busyScenes: readonly string[];
  /** Base rig ids ("bear" for "bear.blush") that the busy scenes draw with. */
  busyRigs: readonly string[];
}

const WRITABLE = ['scenes', 'src/rigs', 'src/audio'];

/** The path relative to the repo, or null when it is outside it. */
function inRepo(root: string, path: string): string | null {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

/** A rig file that a busy scene may draw with: named after one of its rigs, or a shared part. */
function busyRigFile(rel: string, busyRigs: readonly string[]): boolean {
  if (!rel.startsWith('src/rigs/')) return false;
  if (rel.startsWith('src/rigs/parts/')) return busyRigs.length > 0;
  const name = rel.slice('src/rigs/'.length).split('/').pop() ?? '';
  return busyRigs.some((rig) => name === `${rig}.ts` || name.startsWith(`${rig}-`) || name.startsWith(`${rig}.`));
}

export function judge(action: Action, ctx: AccessContext): Verdict {
  if (action.kind === 'scene') {
    if (ctx.busyScenes.includes(action.sceneId)) {
      return { allow: false, ask: false, reason: `Another request is working on scene "${action.sceneId}" right now; edit only "${ctx.sceneId}", or try again once that request's turn ends.` };
    }
    if (ctx.access === 'full') return { allow: true };
    return { allow: false, ask: true, summary: `Change scene "${action.sceneId}" with ${action.tool}`, detail: `This request is about "${ctx.sceneId}".` };
  }
  if (action.kind === 'write') {
    const rels = action.paths.map((p) => ({ path: p, rel: inRepo(ctx.root, p) }));
    // A scene file is named after its scene, and editing another scene's file is editing that scene.
    for (const { rel } of rels) {
      const other = rel && /^scenes\/([^/]+)\.json$/.exec(rel)?.[1];
      if (other && other !== ctx.sceneId) {
        const verdict = judge({ kind: 'scene', sceneId: other, tool: `an edit to ${rel}` }, ctx);
        if (!verdict.allow) return verdict;
      }
    }
    const busy = rels.filter(({ rel }) => rel !== null && busyRigFile(rel, ctx.busyRigs));
    if (ctx.access === 'full' && busy.length === 0) return { allow: true };
    const outside = rels.filter(({ rel }) => rel === null || !WRITABLE.some((dir) => rel === dir || rel.startsWith(`${dir}/`)));
    if (outside.length === 0 && busy.length === 0) return { allow: true };
    const names = rels.map(({ path, rel }) => rel ?? path).join(', ');
    if (busy.length > 0) {
      return { allow: false, ask: true, summary: `Edit ${names}`, detail: 'Another request is working on a scene that may draw with this rig.' };
    }
    return { allow: false, ask: true, summary: `Edit ${names}`, detail: 'Outside scenes/, src/rigs/ and src/audio/.' };
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
