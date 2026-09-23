// HTML error panel over the stage. Every failure the viewer knows about shows
// here with its full message list, so the page never goes blank without saying why.

/** 'request': the URL asked for a scene that does not exist. */
export type ErrorSource = 'build' | 'hmr' | 'library' | 'request' | 'scene' | 'render' | 'runtime';

const ORDER: readonly ErrorSource[] = ['build', 'hmr', 'library', 'request', 'scene', 'render', 'runtime'];

export interface ErrorReport {
  title: string;
  lines: readonly string[];
  /** Optional preformatted detail (a stack or code frame). */
  detail?: string;
}

export class ErrorPanel {
  readonly element: HTMLElement;
  private readonly reports = new Map<ErrorSource, ErrorReport>();
  private rendered = '';

  constructor(host: HTMLElement) {
    this.element = document.createElement('section');
    this.element.className = 'error-panel';
    this.element.setAttribute('role', 'alert');
    this.element.hidden = true;
    host.appendChild(this.element);
  }

  set(source: ErrorSource, report: ErrorReport | null): void {
    if (report) this.reports.set(source, report);
    else this.reports.delete(source);
    this.render();
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

  private render(): void {
    const ordered = ORDER.flatMap((source) => {
      const report = this.reports.get(source);
      return report ? [{ source, report }] : [];
    });
    const signature = JSON.stringify(ordered);
    if (signature === this.rendered) return;
    this.rendered = signature;

    this.element.replaceChildren();
    this.element.hidden = ordered.length === 0;
    for (const { source, report } of ordered) {
      const block = document.createElement('div');
      block.className = `error-block error-${source}`;
      const title = document.createElement('h2');
      title.textContent = report.title;
      block.appendChild(title);
      if (report.lines.length > 0) {
        const list = document.createElement('ul');
        for (const line of report.lines) {
          const item = document.createElement('li');
          item.textContent = line;
          list.appendChild(item);
        }
        block.appendChild(list);
      }
      if (report.detail) {
        const pre = document.createElement('pre');
        pre.textContent = report.detail;
        block.appendChild(pre);
      }
      this.element.appendChild(block);
    }
  }
}

export function errorText(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const stack = err.stack && err.stack.includes(err.message) ? err.stack : err.stack ? `${err.message}\n${err.stack}` : undefined;
    return { message: err.message || err.name, stack };
  }
  return { message: String(err) };
}
