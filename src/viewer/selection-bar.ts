// The selection bar: a row in the control footer that shows what is picked
// (scene, layer › part, frame range) and lets you type the range or clear
// either half. Plain DOM; it never touches the canvas.

import type { FrameRange, RangeText } from './selection';

export interface SelectionBarHandlers {
  clearLayer(): void;
  clearRange(): void;
  /** Applies a typed range end. Returns an error message and changes nothing when the text is invalid. */
  editRange(end: 'from' | 'to', text: string): string | null;
}

export interface SelectionBarState {
  /** Null when no valid scene is showing; the bar is then disabled. */
  sceneId: string | null;
  /** "bear › nose", or empty for no layer. */
  layer: string;
  range: FrameRange | null;
  rangeText: RangeText | null;
  frameCount: number;
  /** A message about the selection, e.g. a layer that vanished in a hot edit. */
  notice: string | null;
}

const CLEAR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function clearButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'sel-clear');
  button.type = 'button';
  button.innerHTML = CLEAR_ICON;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', () => {
    onClick();
    // Hand focus back so Space, the arrows, I, O and Escape drive the viewer again.
    button.blur();
  });
  return button;
}

export class SelectionBar {
  readonly element: HTMLElement;
  private readonly sceneValue: HTMLElement;
  private readonly layerValue: HTMLElement;
  private readonly clearLayerButton: HTMLButtonElement;
  private readonly interval: HTMLElement;
  private readonly timecodes: HTMLElement;
  private readonly count: HTMLElement;
  private readonly fields: Record<'from' | 'to', HTMLInputElement>;
  private readonly fieldError: HTMLElement;
  private readonly clearRangeButton: HTMLButtonElement;
  private readonly notice: HTMLElement;
  private state: SelectionBarState | null = null;
  /** The range the fields last showed, so a range change from elsewhere refreshes them. */
  private shownRange = '';

  constructor(host: HTMLElement, private readonly handlers: SelectionBarHandlers) {
    this.element = el('div', 'controls-row selection-bar');
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Selection');

    const scene = el('span', 'sel-group');
    scene.append(el('span', 'label', 'Scene'));
    this.sceneValue = el('output', 'sel-value sel-scene', '-');
    scene.append(this.sceneValue);

    const layer = el('span', 'sel-group');
    layer.append(el('span', 'label', 'Layer'));
    this.layerValue = el('output', 'sel-value sel-layer', '');
    this.layerValue.setAttribute('aria-label', 'Selected layer');
    this.clearLayerButton = clearButton('Clear layer (Esc)', () => handlers.clearLayer());
    layer.append(this.layerValue, this.clearLayerButton);

    const range = el('span', 'sel-group');
    range.append(el('span', 'label', 'Range'));
    this.interval = el('output', 'sel-value sel-interval', '');
    this.interval.setAttribute('aria-label', 'Frame range');
    this.timecodes = el('span', 'sel-timecodes', '');
    this.count = el('span', 'sel-count', '');
    range.append(this.interval, this.timecodes, this.count);

    const edit = el('span', 'sel-group sel-edit');
    this.fields = { from: this.field('from', 'From frame (included)'), to: this.field('to', 'To frame (excluded)') };
    edit.append(el('span', 'label', 'from'), this.fields.from, el('span', 'label', 'to'), this.fields.to);
    this.clearRangeButton = clearButton('Clear range', () => handlers.clearRange());
    edit.append(this.clearRangeButton);
    this.fieldError = el('span', 'sel-error', '');
    this.fieldError.setAttribute('role', 'status');
    this.fieldError.setAttribute('aria-live', 'polite');
    this.fieldError.hidden = true;

    this.notice = el('span', 'sel-notice', '');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    this.notice.hidden = true;

    const hint = el('div', 'hint');
    hint.innerHTML =
      'click select <span class="sep">·</span> again to cycle <span class="sep">·</span> <kbd>Alt</kbd>+click part ' +
      '<span class="sep">·</span> <kbd>I</kbd><kbd>O</kbd> range <span class="sep">·</span> <kbd>Esc</kbd> clear';

    this.element.append(scene, layer, range, edit, this.fieldError, this.notice, el('span', 'spacer'), hint);
    host.appendChild(this.element);
  }

  set(state: SelectionBarState): void {
    this.state = state;
    const enabled = state.sceneId !== null;
    this.element.classList.toggle('is-disabled', !enabled);
    setText(this.sceneValue, state.sceneId ?? '-');

    const hasLayer = state.layer !== '';
    setText(this.layerValue, hasLayer ? state.layer : 'none');
    this.layerValue.classList.toggle('is-empty', !hasLayer);
    this.clearLayerButton.disabled = !hasLayer;

    const text = state.rangeText;
    setText(this.interval, text ? text.interval : '-');
    this.interval.classList.toggle('is-empty', state.range === null);
    setText(this.timecodes, text?.timecodes ?? '');
    this.timecodes.hidden = !text?.timecodes;
    setText(this.count, text ? text.count : '');
    this.clearRangeButton.disabled = state.range === null;

    const signature = JSON.stringify([state.range, state.frameCount, enabled]);
    if (signature !== this.shownRange) {
      this.shownRange = signature;
      this.showError(null);
      for (const end of ['from', 'to'] as const) this.refreshField(end, true);
    } else {
      for (const end of ['from', 'to'] as const) this.refreshField(end, false);
    }

    setText(this.notice, state.notice ?? '');
    this.notice.hidden = !state.notice;
  }

  private field(end: 'from' | 'to', label: string): HTMLInputElement {
    const input = el('input', 'sel-field');
    input.type = 'text';
    input.inputMode = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.size = 8;
    input.setAttribute('aria-label', `${label}: a frame number or MM:SS:FF`);
    input.title = `${label}. A frame number or MM:SS:FF; Enter applies, Esc reverts.`;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.commit(end)) input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.showError(null);
        this.refreshField(end, true);
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      if (input.value !== this.displayValue(end)) this.commit(end);
    });
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') this.showError(null);
    });
    return input;
  }

  /** Applies the field's text. Returns true when applied (or nothing changed). */
  private commit(end: 'from' | 'to'): boolean {
    const input = this.fields[end];
    if (!this.state || this.state.sceneId === null) return false;
    if (input.value === this.displayValue(end)) return true;
    const error = this.handlers.editRange(end, input.value);
    if (error) {
      this.showError(error, end);
      return false;
    }
    this.showError(null);
    return true;
  }

  private displayValue(end: 'from' | 'to'): string {
    const range = this.state?.range;
    return range ? String(range[end]) : '';
  }

  /** Shows the current range in a field, unless the user is typing in it or it holds rejected text (force overrides). */
  private refreshField(end: 'from' | 'to', force: boolean): void {
    const input = this.fields[end];
    const enabled = this.state?.sceneId != null;
    input.disabled = !enabled;
    input.placeholder = end === 'from' ? '0' : String(this.state?.frameCount ?? '');
    const busy = document.activeElement === input || input.getAttribute('aria-invalid') === 'true';
    if (force || !busy) {
      const value = this.displayValue(end);
      if (input.value !== value) input.value = value;
    }
  }

  private showError(message: string | null, end?: 'from' | 'to'): void {
    for (const key of ['from', 'to'] as const) {
      if (key === end && message) this.fields[key].setAttribute('aria-invalid', 'true');
      else this.fields[key].removeAttribute('aria-invalid');
    }
    setText(this.fieldError, message ? `${end}: ${message}` : '');
    this.fieldError.hidden = !message;
  }
}
