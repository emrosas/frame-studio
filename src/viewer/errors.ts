// The viewer's error log. Every failure the viewer knows about is kept here
// with its full message list, and ErrorPanel.svelte shows it over the stage,
// so the page never goes blank without saying why.

import type { ErrorBlock } from './ui.svelte';

/** 'request': the URL asked for a scene that does not exist. */
export type ErrorSource = 'server' | 'build' | 'hmr' | 'library' | 'project' | 'request' | 'scene' | 'render' | 'audio' | 'media' | 'runtime';

const ORDER: readonly ErrorSource[] = ['server', 'build', 'hmr', 'library', 'project', 'request', 'scene', 'render', 'audio', 'media', 'runtime'];

export interface ErrorReport {
  title: string;
  lines: readonly string[];
  /** Optional preformatted detail (a stack or code frame). */
  detail?: string;
}

export class ErrorLog {
  private readonly reports = new Map<ErrorSource, ErrorReport>();
  private shown = '';
  private readonly onChange: (blocks: ErrorBlock[]) => void;

  /** onChange gets the blocks to show, in display order, whenever they change. */
  constructor(onChange: (blocks: ErrorBlock[]) => void) {
    this.onChange = onChange;
  }

  set(source: ErrorSource, report: ErrorReport | null): void {
    if (report) this.reports.set(source, report);
    else this.reports.delete(source);
    const blocks = ORDER.flatMap((s) => {
      const r = this.reports.get(s);
      return r ? [{ source: s, ...r }] : [];
    });
    const signature = JSON.stringify(blocks);
    if (signature === this.shown) return;
    this.shown = signature;
    this.onChange(blocks);
  }

  /** Flat list for window.studio.errors: "title: line". */
  get messages(): string[] {
    const out: string[] = [];
    for (const source of ORDER) {
      const report = this.reports.get(source);
      if (!report) continue;
      if (report.lines.length === 0) out.push(report.title);
      for (const line of report.lines) out.push(`${report.title}: ${line}`);
    }
    return out;
  }
}

export function errorText(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const stack = err.stack && err.stack.includes(err.message) ? err.stack : err.stack ? `${err.message}\n${err.stack}` : undefined;
    return { message: err.message || err.name, stack };
  }
  return { message: String(err) };
}
