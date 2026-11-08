// An agent's words in a thread are Markdown. marked reads them into tokens, and
// this turns those into a small tree the Markdown component draws with Svelte,
// so nothing an agent writes is ever set as HTML: a tag in its text shows as
// text, a link goes only to http, https or mailto, and an image shows as a link
// to it rather than loading anything.

import { Lexer, type Token, type Tokens } from 'marked';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'link'; href: string | null; children: Inline[] }
  | { kind: 'break' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** A task list's box, or null for a plain item. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

/** The schemes a link may use; anything else shows as plain text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function inline(tokens: readonly Token[] | undefined): Inline[] {
  const out: Inline[] = [];
  const text = (t: string) => {
    const last = out.at(-1);
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
        out.push({ kind: token.type, children: inline((token as Tokens.Strong).tokens) });
        break;
      case 'codespan':
        out.push({ kind: 'code', text: (token as Tokens.Codespan).text });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        out.push({ kind: 'link', href: safeHref(link.href), children: inline(link.tokens) });
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        out.push({ kind: 'link', href: safeHref(image.href), children: [{ kind: 'text', text: image.text || image.href }] });
        break;
      }
      case 'br':
        out.push({ kind: 'break' });
        break;
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) out.push(...inline(t.tokens));
        else text(t.text);
        break;
      }
      case 'escape':
      case 'html':
        text((token as Tokens.Escape).text);
        break;
      default:
        if ('text' in token && typeof token.text === 'string') text(token.text);
    }
  }
  return out;
}

const level = (depth: number) => Math.min(6, Math.max(1, depth)) as 1 | 2 | 3 | 4 | 5 | 6;

function blocks(tokens: readonly Token[]): Block[] {
  const out: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph':
        out.push({ kind: 'paragraph', children: inline((token as Tokens.Paragraph).tokens) });
        break;
      case 'text': {
        // A tight list item's words arrive as block-level text.
        const t = token as Tokens.Text;
        out.push({ kind: 'paragraph', children: t.tokens ? inline(t.tokens) : [{ kind: 'text', text: t.text }] });
        break;
      }
      case 'heading': {
        const h = token as Tokens.Heading;
        out.push({ kind: 'heading', level: level(h.depth), children: inline(h.tokens) });
        break;
      }
      case 'code': {
        const c = token as Tokens.Code;
        out.push({ kind: 'code', lang: (c.lang ?? '').trim().split(/\s/)[0] ?? '', text: c.text });
        break;
      }
      case 'list': {
        const l = token as Tokens.List;
        out.push({
          kind: 'list',
          ordered: l.ordered,
          start: typeof l.start === 'number' ? l.start : 1,
          tight: !l.loose,
          items: l.items.map((item) => ({ checked: item.task ? item.checked === true : null, blocks: blocks(item.tokens.filter((t) => t.type !== 'checkbox')) })),
        });
        break;
      }
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocks((token as Tokens.Blockquote).tokens) });
        break;
      case 'table': {
        const t = token as Tokens.Table;
        out.push({ kind: 'table', align: t.align.map((a) => a ?? null), header: t.header.map((cell) => inline(cell.tokens)), rows: t.rows.map((row) => row.map((cell) => inline(cell.tokens))) });
        break;
      }
      case 'hr':
        out.push({ kind: 'rule' });
        break;
      case 'html':
        // Raw HTML shows as the text it is.
        out.push({ kind: 'paragraph', children: [{ kind: 'text', text: (token as Tokens.HTML).text.trimEnd() }] });
        break;
      default:
        // space and link definitions draw nothing.
        break;
    }
  }
  return out;
}

/** Reads GitHub-flavoured Markdown. Text still streaming in reads as far as it goes. */
export function parseMarkdown(source: string): Block[] {
  return blocks(Lexer.lex(source, { gfm: true }));
}
