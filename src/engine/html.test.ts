import { describe, expect, it } from 'vitest';
import { htmlKey, htmlPageKey, htmlPageOf, htmlRequest, htmlUsed, isHtmlPath } from './html';
import { picturesAt } from './picture';
import { validateScene } from './validate';
import type { Scene } from './types';

const page = { id: 'page', html: 'html/launch/1.html' };
const still = (rest: Partial<Scene> = {}): Scene => ({ id: 's', fps: 1, duration: 1, size: [1080, 1350], seed: 1, layers: [page], ...rest });
const errors = (scene: unknown) => {
  const r = validateScene(scene);
  return r.ok ? [] : r.errors;
};

describe('html paths (ADR 0021)', () => {
  it('are .html files inside html/', () => {
    expect(isHtmlPath('html/launch/1.html')).toBe(true);
    expect(isHtmlPath('html/a.htm')).toBe(true);
    expect(isHtmlPath('html/launch/1.css')).toBe(false);
    expect(isHtmlPath('media/1.html')).toBe(false);
    expect(isHtmlPath('html/../scenes/x.html')).toBe(false);
    expect(isHtmlPath('html//x.html')).toBe(false);
    expect(isHtmlPath('html\\x.html')).toBe(false);
    expect(isHtmlPath('/html/x.html')).toBe(false);
    expect(isHtmlPath(7)).toBe(false);
  });
});

describe('html requests and keys', () => {
  it('ask for the page at the stage size, with what was moved', () => {
    expect(htmlRequest(page, still())).toEqual({ file: 'html/launch/1.html', width: 1080, height: 1350, offsets: {} });
    expect(htmlRequest({ rig: 'circle' } as never, still())).toBeNull();
    expect(picturesAt(still(), 0)).toEqual([{ file: 'html/launch/1.html@1080x1350', t: 0, html: { file: 'html/launch/1.html', width: 1080, height: 1350, offsets: {} } }]);
  });

  it('name a moved page apart from the page as written, in any order of its offsets', () => {
    const plain = htmlRequest(page, still())!;
    const moved = htmlRequest({ ...page, offsets: { '.b': [3, 4], '#a': [1, 2] } }, still())!;
    const same = htmlRequest({ ...page, offsets: { '#a': [1, 2], '.b': [3, 4] } }, still())!;
    expect(htmlKey(moved)).not.toBe(htmlKey(plain));
    expect(htmlKey(moved)).toBe(htmlKey(same));
    expect(htmlKey(htmlRequest({ ...page, offsets: { '#a': [1, 3] } }, still())!)).not.toBe(htmlKey(moved));
    // Both belong to one page, so a host can show the last drawing while the next is made.
    expect(htmlPageOf(htmlKey(moved))).toBe(htmlPageKey(plain));
    expect(htmlPageOf(htmlKey(plain))).toBe(htmlPageKey(plain));
    expect(htmlPageOf('media/clip.mp4')).toBe('media/clip.mp4');
  });

  it('list the pages a scene shows', () => {
    expect(htmlUsed(still({ layers: [page, { id: 'two', html: 'html/launch/1.html' }, { id: 'c', html: 'html/a.html' }] }))).toEqual(['html/a.html', 'html/launch/1.html']);
    expect(htmlUsed(still({ layers: [] }))).toEqual([]);
  });
});

describe('validating an html layer', () => {
  it('takes a page on a still, with placement and offsets', () => {
    expect(errors(still())).toEqual([]);
    expect(errors(still({ layers: [{ ...page, params: { x: 10, y: -4, scale: 0.9, opacity: 0.8 }, offsets: { 'div.btn': [12, -8] } }] }))).toEqual([]);
    // One frame, however it says so.
    expect(errors(still({ fps: 30, duration: 1 / 30 }))).toEqual([]);
  });

  it('refuses it off a still, on a pixel stage, and as the background', () => {
    expect(errors(still({ duration: 2 })).join('\n')).toMatch(/layers\[0\]\.html: an html layer belongs on a still/);
    expect(errors(still({ size: [1080, 1920], pixel: { scale: 6 } })).join('\n')).toMatch(/pixel stage/);
    expect(errors({ ...still({ layers: [] }), background: { html: 'html/launch/1.html' } }).join('\n')).toMatch(/background\.html: the background draws a rig/);
  });

  it('refuses a page outside html/, and anything else on the layer that draws or moves', () => {
    expect(errors(still({ layers: [{ id: 'page', html: 'scenes/x.html' }] })).join('\n')).toMatch(/must be an \.html file in the studio folder's html\//);
    expect(errors(still({ layers: [{ ...page, rig: 'circle' }] })).join('\n')).toMatch(/layers\[0\]\.rig: an html layer names only its page/);
    expect(errors(still({ layers: [{ ...page, file: 'media/a.png' }] })).join('\n')).toMatch(/names only its page/);
    for (const [field, value] of [
      ['tracks', [{ param: 'x', keys: [{ t: 0, v: 1 }] }]],
      ['overrides', [{ from: 0, to: 1, params: { x: 1 } }]],
      ['stepFps', 1],
      ['fit', 'cover'],
      ['out', 1],
    ] as const) {
      expect(errors(still({ layers: [{ ...page, [field]: value } as never] })).join('\n')).toMatch(new RegExp(`layers\\[0\\]\\.${field}: an html layer holds still`));
    }
    expect(errors(still({ layers: [{ ...page, params: { volume: 0.5 } }] })).join('\n')).toMatch(/a page makes no sound/);
    expect(errors(still({ layers: [{ ...page, params: { radius: 3 } }] })).length).toBeGreaterThan(0);
  });

  it('checks offsets, and refuses them on any other layer', () => {
    expect(errors(still({ layers: [{ ...page, offsets: { 'div.btn': [1] as never } }] })).join('\n')).toMatch(/offsets\["div\.btn"\]: must be \[x, y\]/);
    expect(errors(still({ layers: [{ ...page, offsets: { '': [1, 2] } }] })).join('\n')).toMatch(/selector must be/);
    expect(errors(still({ layers: [{ ...page, offsets: [] as never }] })).join('\n')).toMatch(/must be an object of selector/);
    expect(errors(still({ layers: [{ id: 'dot', rig: 'circle', offsets: { a: [1, 2] } }] })).join('\n')).toMatch(/only an html layer takes offsets/);
  });
});
