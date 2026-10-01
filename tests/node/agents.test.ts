/**
 * The pure parts of the studio's agents (ADR 0006): the access rules, and how
 * the Claude and Codex adapters map their tools onto them.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, type AccessContext } from '../../tools/studio/agents/access';
import { claudeAction, claudeProvider, claudeStepLabel, summaryOf } from '../../tools/studio/agents/claude';
import { codexPolicy, codexProvider } from '../../tools/studio/agents/codex';

const ROOT = '/repo';
const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({ access: 'studio', root: ROOT, sceneId: 'hello', busyScenes: [], busyRigs: [], ...overrides });
const verdict = (v: ReturnType<typeof judge>) => (v.allow ? 'allow' : v.ask ? 'ask' : 'refuse');

describe('access rules', () => {
  it('lets the studio access write scenes, rigs and generators, and asks for anything else', () => {
    expect(verdict(judge({ kind: 'write', paths: ['src/rigs/bear-wink.ts', 'src/audio/chime.ts'] }, ctx()))).toBe('allow');
    // A studio folder's own rigs and generators (ADR 0008).
    expect(verdict(judge({ kind: 'write', paths: ['/repo/rigs/hat.ts', '/repo/audio/chime.ts'] }, ctx()))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/rigs/bear-hat.ts'] }, ctx({ access: 'full', busyScenes: ['bear-test'], busyRigs: ['bear'] })))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/engine/render.ts'] }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/x.ts', '/repo/package.json'] }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/etc/hosts'] }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/scenes-old/x.json'] }, ctx()))).toBe('ask');
  });

  it('reads the repo freely, and asks to read outside it, run commands, go online or use other tools', () => {
    expect(verdict(judge({ kind: 'read', path: '/repo/src/engine/render.ts' }, ctx()))).toBe('allow');
    expect(verdict(judge({ kind: 'read', path: '/Users/me/.ssh/id_rsa' }, ctx()))).toBe('ask');
    expect(judge({ kind: 'command', command: 'npm test' }, ctx())).toMatchObject({ allow: false, ask: true, summary: 'Run a command', detail: 'npm test' });
    expect(verdict(judge({ kind: 'network', target: 'https://example.com' }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'tool', name: 'Something' }, ctx()))).toBe('ask');
  });

  it('asks before another scene, and refuses one another thread is working on, even with full access', () => {
    expect(verdict(judge({ kind: 'scene', sceneId: 'bears', tool: 'update_scene' }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'scene', sceneId: 'bears', tool: 'update_scene' }, ctx({ access: 'full' })))).toBe('allow');
    expect(verdict(judge({ kind: 'scene', sceneId: 'bears', tool: 'update_scene' }, ctx({ access: 'full', busyScenes: ['bears'] })))).toBe('refuse');
  });

  it("treats editing another scene's file as editing that scene", () => {
    expect(verdict(judge({ kind: 'write', paths: ['/repo/scenes/hello.json'] }, ctx()))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/scenes/bears.json'] }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/scenes/bears.json'] }, ctx({ access: 'full' })))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/scenes/bears.json'] }, ctx({ access: 'full', busyScenes: ['bears'] })))).toBe('refuse');
    // A composition's file is that composition (ADR 0013), and the folder's project.json is writable.
    expect(verdict(judge({ kind: 'write', paths: ['/repo/compositions/trailer.json'] }, ctx()))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/compositions/trailer.json'] }, ctx({ access: 'full', busyScenes: ['trailer'] })))).toBe('refuse');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/compositions/trailer.json'] }, ctx({ sceneId: 'trailer' })))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/project.json'] }, ctx()))).toBe('allow');
  });

  it("asks before editing a rig a busy scene draws with, or a shared part, even with full access", () => {
    const busy = ctx({ access: 'full', busyScenes: ['bear-test'], busyRigs: ['bear', 'paper'] });
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/bear-blush.ts'] }, busy))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/bear.ts'] }, busy))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/parts/paint.ts'] }, busy))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/star.ts'] }, busy))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/src/rigs/bearded.ts'] }, busy))).toBe('allow');
  });

  it("writes a project's rigs and its own scene freely, and asks before another project's files (ADR 0007)", () => {
    const shot = ctx({ sceneId: 'story/one' });
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/rigs/iris.ts', '/repo/projects/story/one.json'] }, shot))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/two.json'] }, shot))).toBe('ask');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/two.json'] }, ctx({ sceneId: 'story/one', access: 'full', busyScenes: ['story/two'] })))).toBe('refuse');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/other/rigs/hat.ts'] }, shot))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/notes.md'] }, shot))).toBe('ask');
    const busyRig = ctx({ sceneId: 'story/one', access: 'full', busyScenes: ['story/two'], busyRigs: ['iris'] });
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/rigs/iris.ts'] }, busyRig))).toBe('ask');
  });

  it('lets a thread change its own project.json once nothing else in the project works, and asks about another project', () => {
    const shot = ctx({ sceneId: 'story/one' });
    expect(verdict(judge({ kind: 'project', projectId: 'story', tool: 'update_project' }, shot))).toBe('allow');
    expect(verdict(judge({ kind: 'write', paths: ['/repo/projects/story/project.json'] }, shot))).toBe('allow');
    expect(verdict(judge({ kind: 'project', projectId: 'other', tool: 'update_project' }, shot))).toBe('ask');
    expect(verdict(judge({ kind: 'project', projectId: 'other', tool: 'update_project' }, ctx({ access: 'full' })))).toBe('allow');
    const busy = judge({ kind: 'write', paths: ['/repo/projects/story/project.json'] }, ctx({ sceneId: 'story/one', access: 'full', busyScenes: ['story/two', 'hello'] }));
    expect(busy).toMatchObject({ allow: false, ask: false, wait: true });
    expect(!busy.allow && !busy.ask && busy.reason).toMatch(/waits until no other request there is working; "story\/two" is still working/);
    // Work in another project, or on loose scenes, doesn't hold it up.
    expect(verdict(judge({ kind: 'project', projectId: 'story', tool: 'update_project' }, ctx({ sceneId: 'story/one', busyScenes: ['other/one', 'hello'] })))).toBe('allow');
  });

  it('with full access, allows everything else without asking', () => {
    for (const action of [
      { kind: 'write' as const, paths: ['/repo/src/engine/render.ts'] },
      { kind: 'command' as const, command: 'rm -rf out' },
      { kind: 'network' as const, target: 'x' },
      { kind: 'read' as const, path: '/etc/hosts' },
    ]) {
      expect(verdict(judge(action, ctx({ access: 'full' }))), action.kind).toBe('allow');
    }
  });
});

describe('the Claude adapter', () => {
  it("maps Claude's tools onto the access rules", () => {
    expect(claudeAction('mcp__frame-studio__apply_to_selection', {}, ROOT)).toBeNull();
    expect(claudeAction('TodoWrite', {}, ROOT)).toBeNull();
    expect(claudeAction('Read', { file_path: '/repo/CLAUDE.md' }, ROOT)).toEqual({ kind: 'read', path: '/repo/CLAUDE.md' });
    expect(claudeAction('Grep', { pattern: 'x' }, ROOT)).toEqual({ kind: 'read', path: ROOT });
    expect(claudeAction('Edit', { file_path: '/repo/src/rigs/bear.ts' }, ROOT)).toEqual({ kind: 'write', paths: ['/repo/src/rigs/bear.ts'] });
    expect(claudeAction('Bash', { command: 'npm test' }, ROOT)).toEqual({ kind: 'command', command: 'npm test' });
    expect(claudeAction('WebFetch', { url: 'https://x.dev' }, ROOT)).toEqual({ kind: 'network', target: 'https://x.dev' });
    expect(claudeAction('mcp__other__thing', { a: 1 }, ROOT)).toMatchObject({ kind: 'tool', name: 'mcp__other__thing' });
  });

  it('labels steps for the transcript', () => {
    expect(claudeStepLabel('mcp__frame-studio__render_frame', {}, ROOT)).toBe('Studio: render_frame');
    expect(claudeStepLabel('Edit', { file_path: '/repo/src/rigs/bear.ts' }, ROOT)).toBe('Edit src/rigs/bear.ts');
    expect(claudeStepLabel('Bash', { command: 'npm test\nnpm run build' }, ROOT)).toBe('Run npm test');
    expect(claudeStepLabel('ToolSearch', {}, ROOT)).toBe('Look up tools');
  });

  it("takes the reply's last line as the summary", () => {
    expect(summaryOf('Looked at it.\n\nMade the ball blue over frames 12 to 24.\n')).toBe('Made the ball blue over frames 12 to 24.');
    expect(summaryOf('')).toBe('');
    expect(summaryOf('x'.repeat(400))).toHaveLength(298);
  });
});

describe('the Codex adapter', () => {
  it('asks through Codex for every change and unsafe command in the studio access, and for nothing with full access', () => {
    expect(codexPolicy('studio')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
    expect(codexPolicy('full')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  });
});

describe('provider status, with no login handled by the studio', () => {
  const withPath = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      return await fn();
    } finally {
      process.env.PATH = saved;
    }
  };

  it('says which command installs a missing CLI', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'frame-studio-path-'));
    try {
      expect(await withPath(empty, () => claudeProvider().status())).toMatchObject({ ready: false, fix: 'npm install -g @anthropic-ai/claude-code' });
      expect(await withPath(empty, () => codexProvider().status())).toMatchObject({ ready: false, fix: 'npm install -g @openai/codex' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('says which command signs a CLI in, and reads a signed-in one as ready', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'frame-studio-path-'));
    const fake = (name: string, script: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    try {
      fake('claude', `echo '{"loggedIn": false}'`);
      fake('codex', `echo 'Not logged in' >&2; exit 1`);
      expect(await withPath(bin, () => claudeProvider().status())).toMatchObject({ ready: false, fix: 'claude auth login' });
      expect(await withPath(bin, () => codexProvider().status())).toMatchObject({ ready: false, fix: 'codex login' });
      fake('claude', `echo 'note: update available' >&2; echo '{"loggedIn": true, "authMethod": "claude.ai"}'`);
      expect(await withPath(bin, () => claudeProvider().status())).toMatchObject({ ready: true, detail: 'Signed in with your Claude account' });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
