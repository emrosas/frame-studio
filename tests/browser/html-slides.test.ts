/**
 * HTML layers on the slides they were built for (ADR 0021): the six pages of
 * the business-owner-loading carousel, imported into a temporary studio folder
 * and compared with the Playwright renders that sit beside them. The pages
 * live in another repo on the owner's machine and load web fonts and images
 * from the network on import, so this file skips where they aren't. Nothing
 * there is written to.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { startStudio, type TestStudio } from './studio-server';

const POST = process.env.FRAME_STUDIO_SLIDES ?? join(homedir(), 'git/r_admin-dashboard/tools/social/posts/business-owner-loading');
const there = existsSync(join(POST, '6.html')) && existsSync(join(POST, 'out/6.png'));
const SLIDES = [1, 2, 3, 4, 5, 6];
const ID = (n: number) => `business-owner-loading-${n}`;

/**
 * How far a slide may sit from its Playwright render. The two are different Chromium builds, 152 in
 * Electron and 153 in Playwright, and the blurred photographs behind slides 1, 3 and 6 come out a few
 * levels apart across most of the frame. So the bar is on pixels that are visibly off: at most 0.5% of
 * the frame more than 32 levels away, and a mean difference under 1.5 levels of 255.
 */
const FAR = 32;
const FAR_SHARE = 0.005;
const MEAN = 1.5;

let folder: string;
let studio: TestStudio;
let browser: Browser;

async function pixels(file: string): Promise<{ width: number; height: number; data: Uint8ClampedArray; hash: string }> {
  const image = await loadImage(readFileSync(file));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data, hash: createHash('sha256').update(data).digest('hex') };
}

function distance(a: Uint8ClampedArray, b: Uint8ClampedArray): { far: number; mean: number; max: number } {
  let far = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > FAR) far++;
    if (d > max) max = d;
    sum += d;
  }
  const count = a.length / 4;
  return { far: far / count, mean: sum / count, max };
}

describe.skipIf(!there)('the carousel as html stills', () => {
  const first = new Map<number, string>();

  beforeAll(async () => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-html-slides-')));
    mkdirSync(join(folder, 'scenes'), { recursive: true });
    studio = await startStudio({ folder, hmr: true });
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('imports the folder as six stills, with what the pages use beside them and nothing left on the network', async () => {
    const w = await studio.server.workspace();
    const made = await w.createHtmlStills({ files: [POST] });
    expect(made.failed).toEqual([]);
    expect(made.scenes.map((s) => s.id)).toEqual(SLIDES.map(ID));
    // Six pages made together are one post, in order.
    expect(made.carousel).toBe('business-owner-loading');
    expect(await w.carousels()).toEqual([{ id: 'business-owner-loading', slides: SLIDES.map(ID) }]);
    expect(made.scenes.map((s) => s.html)).toEqual(SLIDES.map((n) => `html/business-owner-loading/posts/business-owner-loading/${n}.html`));
    // The kit keeps its place two folders up, so the pages' own paths still work.
    for (const file of ['kit/base.css', 'kit/carousel.css', 'kit/fraunces-soft.woff2', 'kit/logo-light.svg', 'posts/business-owner-loading/cover.jpg']) {
      expect(existsSync(join(folder, 'html/business-owner-loading', file)), file).toBe(true);
    }
    // Google Fonts' stylesheets and files, and the photographs, are files now.
    expect(made.localized.some((l) => l.url.includes('fonts.googleapis.com') && l.file.endsWith('.css'))).toBe(true);
    expect(made.localized.some((l) => l.file.endsWith('.woff2'))).toBe(true);
    expect(made.localized.some((l) => !l.url.includes('fonts.g') && /\.(jpg|png|webp)$/.test(l.file))).toBe(true);
    for (const n of SLIDES) {
      const page = readFileSync(join(folder, made.scenes[n - 1].html), 'utf8');
      expect(page, `slide ${n}`).not.toMatch(/https?:\/\//);
      expect(JSON.parse(readFileSync(join(folder, `scenes/${ID(n)}.json`), 'utf8'))).toMatchObject({ fps: 1, duration: 1, size: [1080, 1350], layers: [{ id: 'page', html: made.scenes[n - 1].html }] });
    }
    expect(readFileSync(join(folder, 'html/business-owner-loading/kit/base.css'), 'utf8')).not.toMatch(/https?:\/\//);
  });

  it('exports each at exactly 1080x1350, within tolerance of the Playwright render', async () => {
    const w = await studio.server.workspace();
    const out = await w.exportStills({ sceneIds: SLIDES.map(ID) });
    expect(out.failed).toEqual([]);
    const report: string[] = [];
    for (const n of SLIDES) {
      const ours = await pixels(join(folder, `out/${ID(n)}/${ID(n)}.png`));
      const theirs = await pixels(join(POST, `out/${n}.png`));
      expect([ours.width, ours.height], `slide ${n}`).toEqual([1080, 1350]);
      expect([theirs.width, theirs.height]).toEqual([1080, 1350]);
      const d = distance(ours.data, theirs.data);
      report.push(`slide ${n}: ${(d.far * 100).toFixed(3)}% over ${FAR} levels, mean ${d.mean.toFixed(3)}, max ${d.max}`);
      expect(d.far, report.at(-1)).toBeLessThan(FAR_SHARE);
      expect(d.mean, report.at(-1)).toBeLessThan(MEAN);
      first.set(n, ours.hash);
    }
    console.log(report.join('\n'));
  });

  it('gives the same pixels on a second run, and from a render worker started afresh', async () => {
    const w = await studio.server.workspace();
    await w.exportStills({ sceneIds: SLIDES.map(ID) });
    for (const n of SLIDES) expect((await pixels(join(folder, `out/${ID(n)}/${ID(n)}.png`))).hash, `slide ${n}, second run`).toBe(first.get(n));
    // A new server on the folder starts its own Electron: the restart an app relaunch is.
    await studio.close();
    studio = await startStudio({ folder, hmr: true });
    const again = await studio.server.workspace();
    const out = await again.exportStills({ sceneIds: SLIDES.map(ID) });
    expect(out.failed).toEqual([]);
    for (const n of SLIDES) expect((await pixels(join(folder, `out/${ID(n)}/${ID(n)}.png`))).hash, `slide ${n}, after a restart`).toBe(first.get(n));
  });

  it('names the element under a pixel through hit_test', async () => {
    const w = await studio.server.workspace();
    expect(await w.hitTest(ID(6), 0, 238, 750)).toMatchObject({ layerId: 'page', partId: 'div.btn' });
    expect(await w.hitTest(ID(6), 0, 400, 500)).toMatchObject({ layerId: 'page', partId: 'h1.abs.big' });
  });

  it('shows the same pixels in the viewer, and a click on Get a demo sends a request naming that element', async () => {
    const page: Page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
    try {
      await page.goto(studio.paired(`?scene=${ID(6)}`));
      await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 1);
      const box = async () => (await page.locator('canvas.stage-canvas').boundingBox())!;
      const at = async (x: number, y: number) => {
        const b = await box();
        return { x: b.x + (x / 1080) * b.width, y: b.y + (y / 1350) * b.height };
      };
      // The page has drawn once the button can be found under its pixel.
      const button = await at(238, 750);
      await expect
        .poll(
          async () => {
            await page.mouse.click(button.x, button.y);
            return page.evaluate(() => (window as unknown as { studio: { selection: { layerId?: string; partId?: string } | null } }).studio.selection);
          },
          { timeout: 20_000 },
        )
        .toMatchObject({ layerId: 'page', partId: 'div.btn', from: 0, to: 1 });
      expect((await page.locator('.dock .token-who').textContent())?.trim()).toBe('page › div.btn');

      const panel = page.getByRole('complementary', { name: 'Agent' });
      await panel.getByRole('textbox', { name: 'Prompt' }).fill('make this button orange');
      await panel.getByRole('button', { name: 'Send to agent' }).click();
      await expect.poll(async () => (await studio.server.queue.list()).length, { timeout: 10_000 }).toBe(1);
      const [sent] = await studio.server.queue.list();
      expect(sent.turns[0].ask).toMatchObject({ prompt: 'make this button orange', selection: { sceneId: ID(6), layerId: 'page', partId: 'div.btn', from: 0, to: 1 } });
      const w = await studio.server.workspace();
      const told = await w.describeRequest(sent);
      expect(told).toMatch(/Selection: layer page › div\.btn/);
      expect(told).toMatch(/an HTML layer that shows html\/business-owner-loading\/posts\/business-owner-loading\/6\.html/);
      expect(told).toMatch(/this CSS selector finds in that page, div\.btn/);
    } finally {
      await page.close();
    }
  });
});
