import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref } from './markdown';

describe("an agent's Markdown", () => {
  it('reads headings, paragraphs, emphasis and inline code', () => {
    expect(parseMarkdown('## Plan\n\nMake it **bigger**, *slower* and `x < 2`.')).toEqual([
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Plan' }] },
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'Make it ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'bigger' }] },
          { kind: 'text', text: ', ' },
          { kind: 'em', children: [{ kind: 'text', text: 'slower' }] },
          { kind: 'text', text: ' and ' },
          { kind: 'code', text: 'x < 2' },
          { kind: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('keeps code blocks whole, with their language', () => {
    expect(parseMarkdown('```ts\nconst a = 1 < 2 && b;\n```')).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = 1 < 2 && b;' }]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ kind: 'code', lang: '', text: 'plain' }]);
  });

  it('reads nested, ordered and task lists', () => {
    const [list] = parseMarkdown('- [x] done\n- two\n  3. nested');
    expect(list).toMatchObject({ kind: 'list', ordered: false, tight: true });
    if (list.kind !== 'list') throw new Error('not a list');
    expect(list.items[0]).toEqual({ checked: true, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'done' }] }] });
    expect(list.items[1].checked).toBeNull();
    expect(list.items[1].blocks[1]).toMatchObject({ kind: 'list', ordered: true, start: 3 });
  });

  it('reads tables with their alignment', () => {
    expect(parseMarkdown('| a | b |\n|:-|-:|\n| 1 | 2 |')).toEqual([
      { kind: 'table', align: ['left', 'right'], header: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]], rows: [[[{ kind: 'text', text: '1' }], [{ kind: 'text', text: '2' }]]] },
    ]);
  });

  it('shows raw HTML as the text it is', () => {
    expect(parseMarkdown('A <b>bold</b> claim')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: 'A <b>bold</b> claim' }] }]);
    expect(parseMarkdown('<div onclick="x()">hi</div>')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: '<div onclick="x()">hi</div>' }] }]);
  });

  it('links only to the web and mail, and never loads an image', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(parseMarkdown('[x](javascript:alert(1))')).toEqual([{ kind: 'paragraph', children: [{ kind: 'link', href: null, children: [{ kind: 'text', text: 'x' }] }] }]);
    expect(parseMarkdown('![a cat](https://example.com/cat.png)')).toEqual([{ kind: 'paragraph', children: [{ kind: 'link', href: 'https://example.com/cat.png', children: [{ kind: 'text', text: 'a cat' }] }] }]);
  });

  it('reads text cut off mid-stream as far as it goes', () => {
    expect(parseMarkdown('Some **bo')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: 'Some **bo' }] }]);
    expect(parseMarkdown('```ts\nconst a')).toEqual([{ kind: 'code', lang: 'ts', text: 'const a' }]);
  });
});
