/**
 * Importing pages for html layers (ADR 0021): what a page and a stylesheet
 * point at, the copy that keeps relative paths, and the files a page loaded
 * from the network brought into the folder, with a fake network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { studioFolder } from '../../tools/studio/folder';
import { cssRefs, htmlRefs, htmlSources, importHtml, listHtml } from '../../tools/studio/html';

let root: string;
let src: string;
const folder = () => studioFolder(root, { studio: join(root, '.frame-studio') });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-html-import-')));
  src = realpathSync(mkdtempSync(join(tmpdir(), 'frame-studio-html-pages-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

const put = (file: string, text: string | Buffer) => {
  mkdirSync(join(src, file, '..'), { recursive: true });
  writeFileSync(join(src, file), text);
};

describe('what a page points at', () => {
  it('finds url() and @import in a stylesheet', () => {
    const css = `@import url('https://fonts.example/css?family=A&display=block'); @import "local.css"; .a { background: url(img/a.png) } .b { src: url("f.woff2") format('woff2') } .c { background: url(data:image/png;base64,AA) }`;
    expect(cssRefs(css).map((r) => r.url)).toEqual(['https://fonts.example/css?family=A&display=block', 'img/a.png', 'f.woff2', 'data:image/png;base64,AA', 'local.css']);
  });

  it('finds what a page loads, in tags, inline styles and style blocks, and leaves links to follow alone', () => {
    const html = `<link rel="stylesheet" href="../kit/base.css"><img class="bg" src="https://img.example/a.jpg?w=600&amp;q=85"><a href="https://example.com">x</a>
<div style="background-image: url('https://img.example/face.png')"></div><style>.x { background: url(tile.svg) }</style><img src='cover.jpg'>`;
    expect(htmlRefs(html).map((r) => r.url)).toEqual(['../kit/base.css', 'https://img.example/a.jpg?w=600&q=85', 'https://img.example/face.png', 'cover.jpg', 'tile.svg']);
  });
});

describe('importing pages', () => {
  const FONT_CSS = `@font-face { font-family: 'A'; src: url(https://fonts.example/s/a.woff2) format('woff2'); }`;
  const net: typeof fetch = async (input) => {
    const url = String(input);
    const answer = (body: string | Buffer, type: string) => new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200, headers: { 'content-type': type } });
    if (url === 'https://fonts.example/css?family=A') return answer(FONT_CSS, 'text/css; charset=utf-8');
    if (url === 'https://fonts.example/s/a.woff2') return answer(Buffer.from('woff2-bytes'), 'font/woff2');
    if (url === 'https://img.example/a.jpg?w=600&q=85') return answer(Buffer.from('jpeg-bytes'), 'image/jpeg');
    if (url === 'https://img.example/face.png') return answer(Buffer.from('png-bytes'), 'image/png');
    return new Response('no', { status: 404 });
  };

  beforeEach(() => {
    put('deck/kit/base.css', `@import url('https://fonts.example/css?family=A'); .logo { background: url(logo.svg) }`);
    put('deck/kit/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    put('deck/posts/launch/cover.jpg', Buffer.from('cover'));
    put('deck/posts/launch/1.html', `<link rel="stylesheet" href="../../kit/base.css"><img src="cover.jpg"><img src="https://img.example/a.jpg?w=600&amp;q=85"><div style="background-image:url(https://img.example/face.png)"></div>`);
    put('deck/posts/launch/2.html', `<link rel="stylesheet" href="../../kit/base.css"><img src="https://gone.example/x.png">`);
    put('deck/posts/launch/10.html', `<p>ten</p>`);
    put('deck/posts/launch/notes.txt', 'not a page');
  });

  it('takes files and folders, in counting order', async () => {
    expect((await htmlSources([join(src, 'deck/posts/launch')], root)).map((p) => p.slice(src.length + 1))).toEqual(['deck/posts/launch/1.html', 'deck/posts/launch/2.html', 'deck/posts/launch/10.html']);
    await expect(htmlSources([join(src, 'deck/kit')], root)).rejects.toThrow(/no \.html files/);
    await expect(htmlSources([join(src, 'deck/posts/launch/notes.txt')], root)).rejects.toThrow(/not an \.html file/);
    await expect(htmlSources([join(src, 'nope')], root)).rejects.toThrow(/No file or folder/);
  });

  it('copies pages with what they use, keeps their paths, and brings the network into the folder', async () => {
    const sources = await htmlSources([join(src, 'deck/posts/launch/1.html'), join(src, 'deck/posts/launch/2.html')], root);
    const made = await importHtml(folder(), sources, { fetch: net });
    expect(made.name).toBe('launch');
    expect(made.pages).toEqual(['html/launch/posts/launch/1.html', 'html/launch/posts/launch/2.html']);
    expect(made.copied).toBe(5);
    for (const file of ['kit/base.css', 'kit/logo.svg', 'posts/launch/cover.jpg']) expect(existsSync(join(root, 'html/launch', file)), file).toBe(true);
    // Only what the pages reach is copied.
    expect(existsSync(join(root, 'html/launch/posts/launch/10.html'))).toBe(false);

    expect(made.localized.map((l) => l.url).sort()).toEqual(['https://fonts.example/css?family=A', 'https://fonts.example/s/a.woff2', 'https://img.example/a.jpg?w=600&q=85', 'https://img.example/face.png']);
    expect(made.failed).toEqual([{ url: 'https://gone.example/x.png', error: 'the server answered 404' }]);
    const remote = readdirSync(join(root, 'html/launch/_remote'));
    expect(remote.map((f) => f.replace(/^[0-9a-f]{16}/, '')).sort()).toEqual(['.css', '.jpg', '.png', '.woff2']);

    const one = readFileSync(join(root, 'html/launch/posts/launch/1.html'), 'utf8');
    expect(one).not.toMatch(/https?:/);
    expect(one).toContain('href="../../kit/base.css"');
    expect(one).toContain('src="cover.jpg"');
    expect(one).toMatch(/src="\.\.\/\.\.\/_remote\/[0-9a-f]{16}\.jpg"/);
    expect(one).toMatch(/url\(\.\.\/\.\.\/_remote\/[0-9a-f]{16}\.png\)/);
    const base = readFileSync(join(root, 'html/launch/kit/base.css'), 'utf8');
    expect(base).toMatch(/@import url\('\.\.\/_remote\/[0-9a-f]{16}\.css'\)/);
    expect(base).toContain('url(logo.svg)');
    // The fetched stylesheet points at the font fetched beside it.
    const fontCss = readFileSync(join(root, 'html/launch/_remote', remote.find((f) => f.endsWith('.css'))!), 'utf8');
    expect(fontCss).toMatch(/url\(\.\/[0-9a-f]{16}\.woff2\)/);
    // What couldn't be fetched stays as written.
    expect(readFileSync(join(root, 'html/launch/posts/launch/2.html'), 'utf8')).toContain('https://gone.example/x.png');
    // The source is untouched.
    expect(readFileSync(join(src, 'deck/posts/launch/1.html'), 'utf8')).toContain('https://img.example/a.jpg');

    expect((await listHtml(folder())).map((f) => f.file)).toContain('html/launch/kit/base.css');
  });

  it('numbers the folder when its name is taken, takes a name, and leaves pages already in html/ where they are', async () => {
    const sources = await htmlSources([join(src, 'deck/posts/launch/10.html')], root);
    expect((await importHtml(folder(), sources, { fetch: net })).pages).toEqual(['html/launch/10.html']);
    expect((await importHtml(folder(), sources, { fetch: net })).pages).toEqual(['html/launch-2/10.html']);
    expect((await importHtml(folder(), sources, { fetch: net, name: 'My Deck' })).pages).toEqual(['html/my-deck/10.html']);
    const inside = await htmlSources(['html/launch/10.html'], root);
    expect(await importHtml(folder(), inside, { fetch: net })).toMatchObject({ pages: ['html/launch/10.html'], copied: 0 });
  });

  it('refuses a page that names a file that is not there', async () => {
    put('deck/posts/launch/3.html', `<img src="missing.png">`);
    const sources = await htmlSources([join(src, 'deck/posts/launch/3.html')], root);
    await expect(importHtml(folder(), sources, { fetch: net })).rejects.toThrow(/missing\.png \(from 3\.html\)/);
    expect(existsSync(join(root, 'html'))).toBe(false);
  });
});
