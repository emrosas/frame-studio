/**
 * M4: the single-file HTML embed, opened from disk in Playwright's headless
 * Chromium with the network off.
 *
 * - It plays from a file:// URL and makes no request but the file itself.
 * - Its frames match the headless renderer's (render.html) pixel for pixel,
 *   in the same browser launch (ticket 03).
 * - It plays on load, loops, and answers play, pause and seek from the page
 *   and from a cross-origin host page.
 * - The engine and player stay under 50 KB minified, and only the rigs the
 *   scene uses are bundled.
 * - A scene with audio (M7) bundles only its generators, starts muted, plays
 *   sound once the speaker button is clicked, and stays in step after a seek.
 *   A silent scene or export carries no audio code.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scene } from '../../src/engine/types';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbedApi, EmbedState } from '../../src/embed/player';
import { buildEmbed, inlineSafe, sceneLiteral, stripDescriptions, type EmbedBuild } from '../../tools/bundle/embed';
import { launchBrowser, openStudio, type Studio } from '../../tools/render/studio';

let browser: Browser;
let studio: Studio;
let dir: string;
const embeds = new Map<string, { build: EmbedBuild; url: string }>();

beforeAll(async () => {
  browser = await launchBrowser();
  studio = await openStudio('bear-test', { browser });
  dir = mkdtempSync(join(tmpdir(), 'frame-studio-embed-'));
  for (const key of ['bear-test', 'shapes-test', 'audio-test']) {
    const build = await buildEmbed(key, { measureRuntime: true });
    const path = join(dir, `${key}.html`);
    writeFileSync(path, build.html);
    embeds.set(key, { build, url: pathToFileURL(path).href });
  }
  const silent = await buildEmbed('audio-test', { silent: true, measureRuntime: true });
  writeFileSync(join(dir, 'audio-test-silent.html'), silent.html);
  embeds.set('audio-test-silent', { build: silent, url: pathToFileURL(join(dir, 'audio-test-silent.html')).href });
});

afterAll(async () => {
  await studio?.close();
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Opened {
  page: Page;
  context: BrowserContext;
  requests: string[];
  problems: string[];
}

/** Opens an embed from disk in a fresh context with the network off. */
async function openEmbed(key: string, query = ''): Promise<Opened> {
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 960, height: 540 } });
  await context.setOffline(true);
  const page = await context.newPage();
  const requests: string[] = [];
  const problems: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  await page.goto(embeds.get(key)!.url + query);
  await page.waitForFunction(() => 'studio' in window);
  return { page, context, requests, problems };
}

type EmbedWindow = Window & { studio: EmbedApi };

/** SHA-256 of the embed canvas's RGBA pixels after showing `frame`. */
function embedHash(page: Page, frame: number): Promise<string> {
  return page.evaluate(async (f) => {
    const { studio } = window as unknown as EmbedWindow;
    studio.seek(f);
    const c = studio.canvas;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, frame);
}

const frameOf = (page: Page) => page.evaluate(() => (window as unknown as EmbedWindow).studio.frame);
const playingOf = (page: Page) => page.evaluate(() => (window as unknown as EmbedWindow).studio.playing);

describe('the embed file', () => {
  it('opens from disk with the network off and makes no request but the file itself', async () => {
    const { page, context, requests, problems } = await openEmbed('bear-test', '?autoplay=0');
    try {
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await page.waitForTimeout(300);
      expect(requests).toEqual([embeds.get('bear-test')!.url + '?autoplay=0']);
      expect(problems).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as EmbedWindow).studio.frameCount)).toBe(96);
    } finally {
      await context.close();
    }
  });

  it('keeps the engine and player under 50 KB minified', () => {
    for (const { build } of embeds.values()) {
      expect(build.bytes.runtime).toBeGreaterThan(1024);
      expect(build.bytes.runtime).toBeLessThan(50 * 1024);
    }
  });

  it('bundles only the rigs the scene uses, and no validator', () => {
    const bear = embeds.get('bear-test')!.build;
    const shapes = embeds.get('shapes-test')!.build;
    expect(bear.rigs).toEqual(['bear', 'bear.bandaged', 'paper']);
    expect(shapes.rigs).toEqual(['circle', 'paper', 'rect', 'star']);
    const hasRig = (html: string, id: string) => new RegExp(`id:[\`'"]${id.replace('.', '\\.')}[\`'"]`).test(html);
    for (const id of bear.rigs) expect(hasRig(bear.html, id), id).toBe(true);
    for (const id of ['circle', 'rect', 'star']) expect(hasRig(bear.html, id), id).toBe(false);
    expect(hasRig(shapes.html, 'bear')).toBe(false);
    expect(bear.html).not.toContain('did you mean');
  });

  it('bundles only the generators a scene uses, without their descriptions, and no audio code for silent embeds', () => {
    const sound = embeds.get('audio-test')!.build;
    expect(sound.generators).toEqual(['blip', 'buzz', 'pad']);
    expect(sound.html).toContain('OfflineAudioContext');
    expect(sound.html).not.toContain('Seconds between blips');
    for (const key of ['bear-test', 'shapes-test', 'audio-test-silent']) {
      const { build } = embeds.get(key)!;
      expect(build.generators, key).toEqual([]);
      expect(build.html, key).not.toMatch(/AudioContext|AudioBufferSourceNode/);
    }
    expect(embeds.get('audio-test-silent')!.build.scene.audio).toBeUndefined();
  });
});

describe('building', () => {
  function scenesDir(files: Record<string, unknown>): string {
    const scenes = mkdtempSync(join(dir, 'scenes-'));
    for (const [name, json] of Object.entries(files)) writeFileSync(join(scenes, name), typeof json === 'string' ? json : JSON.stringify(json));
    return scenes;
  }
  const hello = JSON.parse(readFileSync(join(import.meta.dirname, '../../scenes/hello.json'), 'utf8')) as Scene;

  it('refuses an invalid scene and prints the validator messages', async () => {
    const scenes = scenesDir({ 'broken.json': { ...hello, id: 'broken', fps: 0 } });
    await expect(buildEmbed('broken', { scenesDir: scenes })).rejects.toThrow(/scenes\/broken\.json has errors[\s\S]*fps/);
    await expect(buildEmbed('broken', { scenesDir: scenes })).rejects.not.toThrow(/undefined/);
  });

  it('resolves a scene key the way the viewer does: the id first, then the file name', async () => {
    const scenes = scenesDir({ 'hero.json': { ...hello, id: 'villain' }, 'a.json': { ...hello, id: 'hero' } });
    expect((await buildEmbed('hero', { scenesDir: scenes })).scene.id).toBe('hero');
    expect((await buildEmbed('villain', { scenesDir: scenes })).scene.id).toBe('villain');
    await expect(buildEmbed('nobody', { scenesDir: scenes })).rejects.toThrow(/No scene "nobody".*hero.*villain/s);
  });

  it('strips rig and param descriptions, which the player never reads', () => {
    const code = [
      "const rig = { id: 'x', description: 'A rig.', params: { r: { type: 'number', description: `Radius.` } } };",
      "const p = { a: num(1, 0, 2, 'Scene x.'), b: col('#fff', 'Fill ' + 'colour.'), c: choice('a', ['a', 'b'], `Pose.`) };",
      "keep(1, 'kept'); const d = { description: label }; num(1, 0, 2); col('#fff');",
    ].join('\n');
    const out = stripDescriptions(code);
    for (const gone of ['A rig.', 'Radius.', 'Scene x.', 'colour.', 'Pose.']) expect(out).not.toContain(gone);
    expect(out).toContain("num(1, 0, 2, '')");
    expect(out).toContain("keep(1, 'kept')");
    expect(out).toContain('description: label');
    expect(out).toContain("col('#fff');");
    for (const { build } of embeds.values()) expect(build.html).not.toMatch(/Scene x of the top|sticking plaster|rounded rect/);
  });

  it('keeps scene text from closing the inline script', () => {
    const scene = { ...hello, id: '</script><!--<script>alert(1)' };
    const literal = sceneLiteral(scene);
    expect(literal).not.toContain('<');
    expect(new Function(`return ${literal}`)()).toEqual(scene);
    expect(inlineSafe('var a="</script>",b=/<\/script>/u')).toBe('var a="<\\/script>",b=/<\\/script>/u');
    expect(() => inlineSafe('var a="<!--"')).toThrow(/<!--/);
    expect(() => inlineSafe('var a="<script"')).toThrow(/<script/);
  });
});

describe('pixel parity with the headless renderer', () => {
  it.each([
    ['bear-test', [0, 12, 47, 48, 60, 71, 72, 95]],
    ['shapes-test', [0, 10, 11, 23, 35, 36, 47, 48, 71]],
  ] as const)('%s frames match render.html byte for byte', async (key, frames) => {
    await studio.load(key);
    const { page, context } = await openEmbed(key, '?autoplay=0');
    try {
      for (const f of frames) expect(await embedHash(page, f), `${key} frame ${f}`).toBe(await studio.call('pixelHash', f));
    } finally {
      await context.close();
    }
  });
});

describe('playback', () => {
  it('plays on load and loops back to the start', async () => {
    const { page, context } = await openEmbed('bear-test');
    try {
      await page.waitForFunction(() => (window as unknown as EmbedWindow).studio.frame >= 3, undefined, { timeout: 5000 });
      await page.evaluate(() => (window as unknown as EmbedWindow).studio.seek(94));
      await page.waitForFunction(() => (window as unknown as EmbedWindow).studio.frame < 10, undefined, { timeout: 5000 });
      expect(await playingOf(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('with loop=0 stops on the last frame, and play starts again from 0', async () => {
    const { page, context } = await openEmbed('bear-test', '?loop=0&frame=90');
    try {
      await page.waitForFunction(() => !(window as unknown as EmbedWindow).studio.playing, undefined, { timeout: 5000 });
      expect(await frameOf(page)).toBe(95);
      await page.evaluate(() => (window as unknown as EmbedWindow).studio.play());
      expect(await frameOf(page)).toBe(0);
      expect(await playingOf(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('stops for good when a frame fails to draw, and says why', async () => {
    const { page, context } = await openEmbed('bear-test', '?autoplay=0');
    try {
      const result = await page.evaluate(() => {
        const { studio } = window as unknown as EmbedWindow;
        CanvasRenderingContext2D.prototype.fill = () => {
          throw new Error('paint ran out');
        };
        studio.seek(10);
        studio.play();
        return { playing: studio.playing, text: document.getElementById('frame-studio')!.textContent };
      });
      expect(result.playing).toBe(false);
      expect(result.text).toMatch(/could not draw frame 10: paint ran out/);
    } finally {
      await context.close();
    }
  });

  it('pauses, seeks and clamps through window.studio', async () => {
    const { page, context } = await openEmbed('bear-test', '?autoplay=0&frame=12');
    try {
      expect(await frameOf(page)).toBe(12);
      expect(await playingOf(page)).toBe(false);
      expect(await page.evaluate(() => (window as unknown as EmbedWindow).studio.seek(500))).toBe(95);
      expect(await embedHash(page, 47)).toBe(await (async () => (await studio.load('bear-test'), studio.call('pixelHash', 47)))());
    } finally {
      await context.close();
    }
  });
});

describe('a host page on another origin', () => {
  it('drives the embed with postMessage and hears its state back', async () => {
    const host = join(dir, 'host.html');
    writeFileSync(
      host,
      `<!doctype html><iframe id="f" src="${embeds.get('bear-test')!.url}?autoplay=0" width="480" height="270"></iframe>
<script>window.states = []; addEventListener('message', (e) => { if (e.data && e.data.type === 'frame-studio:state') states.push(e.data); });</script>`,
    );
    const context = await browser.newContext();
    await context.setOffline(true);
    const page = await context.newPage();
    try {
      await page.goto(pathToFileURL(host).href);
      type HostWindow = Window & { states: EmbedState[] };
      // The embed announces itself on load.
      await page.waitForFunction(() => (window as unknown as HostWindow).states.length >= 1);
      expect((await page.evaluate(() => (window as unknown as HostWindow).states[0]))).toEqual({
        type: 'frame-studio:state',
        frame: 0,
        playing: false,
        frameCount: 96,
        fps: 12,
      });
      // file:// pages are opaque origins, so the host cannot reach into the iframe; only messages cross.
      expect(await page.evaluate(() => {
        try {
          return typeof ((document.getElementById('f') as HTMLIFrameElement).contentWindow as unknown as EmbedWindow).studio;
        } catch {
          return 'blocked';
        }
      })).toMatch(/blocked|undefined/);
      const send = (message: object) =>
        page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), message);
      await send({ type: 'frame-studio', command: 'seek', frame: 30 });
      await page.waitForFunction(() => (window as unknown as HostWindow).states.some((s) => s.frame === 30));
      await send({ type: 'frame-studio', command: 'play' });
      await page.waitForFunction(() => (window as unknown as HostWindow).states.some((s) => s.playing));
      await send({ type: 'frame-studio', command: 'pause' });
      await page.waitForFunction(() => (window as unknown as HostWindow).states.at(-1)?.playing === false);
      // A bad command still gets an answer, with the reason.
      await send({ type: 'frame-studio', command: 'seek', frame: '40' });
      await page.waitForFunction(() => (window as unknown as HostWindow).states.at(-1)?.error !== undefined);
      expect((await page.evaluate(() => (window as unknown as HostWindow).states.at(-1)))!.error).toMatch(/numeric frame/);
    } finally {
      await context.close();
    }
  });
});

describe('sound', () => {
  type Sound = { muted: boolean; unlocked: boolean; ready: boolean; heard: number | null };
  const sound = (page: Page) => page.evaluate(() => (window as unknown as { studio: { sound: Sound } }).studio.sound);
  /** How far the sound reaching the speakers is from the frame on screen, in seconds. */
  const offBy = (page: Page) =>
    page.evaluate(() => {
      const studio = (window as unknown as EmbedWindow).studio;
      const heard = studio.sound?.heard ?? null;
      return heard === null ? null : Math.abs(heard - studio.frame / studio.fps);
    });

  it('has no speaker button without sound', async () => {
    const { page, context } = await openEmbed('audio-test-silent');
    try {
      expect(await page.getByRole('button').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as EmbedWindow).studio.sound)).toBeNull();
    } finally {
      await context.close();
    }
  });

  it('starts muted, plays after the speaker button is clicked, and stays in step after a seek', async () => {
    const { page, context, problems } = await openEmbed('audio-test');
    try {
      await expect.poll(async () => (await sound(page)).ready).toBe(true);
      // Playing, but silent until someone asks for sound: browsers need a gesture.
      expect(await sound(page)).toMatchObject({ muted: true, heard: null });
      await page.getByRole('button', { name: 'Turn sound on' }).click();
      await expect.poll(async () => (await sound(page)).heard, { timeout: 3000 }).not.toBeNull();
      expect(await sound(page)).toMatchObject({ muted: false, unlocked: true });
      const step = 2 / 30 + 0.04; // the frame on screen is floored, plus the resync tolerance
      await expect.poll(() => offBy(page)).toBeLessThan(step);
      await page.evaluate(() => (window as unknown as EmbedWindow).studio.seek(90));
      await expect.poll(() => offBy(page)).toBeLessThan(step);
      await page.evaluate(() => (window as unknown as EmbedWindow).studio.pause());
      expect((await sound(page)).heard).toBeNull();
      await page.getByRole('button', { name: 'Turn sound off' }).click();
      expect((await sound(page)).muted).toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
