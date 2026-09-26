/**
 * M10: a studio folder outside the repo (ADR 0008). Its own rig in rigs/,
 * written in TypeScript against the built-ins by their @frame-studio/ names,
 * loads through the studio server's module service. An edit shows in the open
 * viewer without a page reload, and the render worker draws it too. A rig
 * can't take a built-in's id.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';
import { renderClient, startStudio, type TestStudio } from './studio-server';

let folder: string;
let studio: TestStudio;
let browser: Browser;

const dotRig = (fill: string) => `import type { Rig } from '@frame-studio/engine/types';
import { col, num, readParams } from '@frame-studio/rigs/parts/params';

const params = { r: num(120, 0, 1000, 'Radius.'), fill: col('${fill}', 'Fill.') };

export const dot: Rig = {
  id: 'dot',
  description: 'A plain dot, for the studio folder test.',
  params,
  draw(ctx, values) {
    const p = readParams(params, values);
    ctx.fillStyle = p.string('fill');
    ctx.beginPath();
    ctx.arc(320, 180, p.number('r'), 0, Math.PI * 2);
    ctx.fill();
  },
};
`;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'frame-studio-folder-'));
  mkdirSync(join(folder, 'scenes'));
  mkdirSync(join(folder, 'rigs'));
  writeFileSync(join(folder, 'rigs/dot.ts'), dotRig('#e05a4f'));
  writeFileSync(
    join(folder, 'scenes/dot-test.json'),
    JSON.stringify({ id: 'dot-test', fps: 12, duration: 1, size: [640, 360], seed: 1, background: { rig: 'paper', params: { tone: '#f4efe6' } }, layers: [{ id: 'dot', rig: 'dot' }] }),
  );
  studio = await startStudio({ folder });
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  rmSync(folder, { recursive: true, force: true });
});

/** The viewer canvas's colour at the middle of the stage. */
const middle = (page: Page) =>
  page.evaluate(() => {
    const canvas = (window as unknown as { studio: { canvas: HTMLCanvasElement } }).studio.canvas;
    const [r, g, b] = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return `${r},${g},${b}`;
  });

describe('a studio folder', () => {
  it("reloads an edited rig in the open viewer without a page reload, and the render worker draws it too", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(studio.paired('?scene=dot-test&frame=0'));
    await page.waitForFunction(() => (window as unknown as { studio?: { frameCount: number } }).studio?.frameCount === 12);
    expect(await page.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors)).toEqual([]);
    await expect.poll(() => middle(page)).toBe('224,90,79');
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    const worker = await renderClient(studio, 'dot-test');
    const before = await worker.call('pixelHash', 0);

    writeFileSync(join(folder, 'rigs/dot.ts'), dotRig('#3355ff'));
    await expect.poll(() => middle(page), { timeout: 15_000 }).toBe('51,85,255');
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    await expect.poll(() => worker.call('pixelHash', 0), { timeout: 15_000 }).not.toBe(before);
    await page.close();
  });

  it("refuses a rig that takes a built-in's id", async () => {
    writeFileSync(join(folder, 'rigs/paper.ts'), dotRig('#000000').replace("id: 'dot'", "id: 'paper'").replace('export const dot', 'export const paper2'));
    const page = await browser.newPage();
    try {
      await page.goto(studio.paired('?scene=dot-test'));
      await page.waitForFunction(() => (window as unknown as { studio?: unknown }).studio !== undefined);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { studio: { errors: string[] } }).studio.errors.join('\n')), { timeout: 15_000 })
        .toMatch(/duplicate rig id "paper"/);
    } finally {
      rmSync(join(folder, 'rigs/paper.ts'), { force: true });
      await page.close();
    }
  });
});
