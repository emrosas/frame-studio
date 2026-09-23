// The control bar under the stage: play/pause, scrubber (with the frame range
// band), timecode, frame and fps readouts, scene picker, shortcut hint. Plain
// DOM; it never touches the canvas.

export interface SceneOption {
  key: string;
  label: string;
  file: string;
  invalid: boolean;
}

export interface TimelineReadout {
  frame: number;
  frameCount: number;
  timecode: string;
  endTimecode: string;
}

export interface ControlsHandlers {
  togglePlay(): void;
  scrubStart(): void;
  scrub(frame: number): void;
  scrubEnd(): void;
  selectScene(key: string): void;
}

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export class Controls {
  readonly element: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly scrubber: HTMLInputElement;
  private readonly band: HTMLElement;
  private readonly timecode: HTMLElement;
  private readonly frameReadout: HTMLElement;
  private readonly fpsReadout: HTMLElement;
  private readonly picker: HTMLSelectElement;
  private sceneSignature = '';
  private playing: boolean | null = null;
  private scrubbing = false;

  constructor(host: HTMLElement, handlers: ControlsHandlers) {
    this.element = el('footer', 'controls');

    const transport = el('div', 'controls-row transport');
    this.playButton = el('button', 'play-button');
    this.playButton.type = 'button';
    this.playButton.setAttribute('aria-keyshortcuts', 'Space');
    this.playButton.addEventListener('click', () => handlers.togglePlay());

    this.timecode = el('output', 'timecode', '--:--:-- / --:--:--');
    this.timecode.setAttribute('aria-label', 'Timecode');

    this.scrubber = el('input', 'scrubber');
    this.scrubber.type = 'range';
    this.scrubber.min = '0';
    this.scrubber.max = '0';
    this.scrubber.step = '1';
    this.scrubber.value = '0';
    this.scrubber.setAttribute('aria-label', 'Frame');
    this.scrubber.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End');
    const endScrub = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      window.removeEventListener('pointerup', endScrub);
      window.removeEventListener('pointercancel', endScrub);
      handlers.scrubEnd();
    };
    this.scrubber.addEventListener('pointerdown', () => {
      if (this.scrubbing) return;
      this.scrubbing = true;
      window.addEventListener('pointerup', endScrub);
      window.addEventListener('pointercancel', endScrub);
      handlers.scrubStart();
    });
    this.scrubber.addEventListener('input', () => handlers.scrub(Number(this.scrubber.value)));
    this.scrubber.addEventListener('change', endScrub);

    // The range band sits behind the scrubber track, with [ and ] marks at the in and out frames.
    const scrubberWrap = el('div', 'scrubber-wrap');
    this.band = el('div', 'range-band');
    this.band.hidden = true;
    this.band.setAttribute('aria-hidden', 'true');
    this.band.append(el('span', 'range-mark is-in'), el('span', 'range-mark is-out'));
    scrubberWrap.append(this.band, this.scrubber);

    this.frameReadout = el('output', 'frame-readout', 'frame -');
    this.frameReadout.setAttribute('aria-label', 'Frame number');

    transport.append(this.playButton, this.timecode, scrubberWrap, this.frameReadout);

    const info = el('div', 'controls-row info');
    const pickerLabel = el('label', 'scene-picker');
    pickerLabel.append(el('span', 'label', 'Scene'));
    this.picker = el('select', 'scene-select');
    this.picker.addEventListener('change', () => {
      handlers.selectScene(this.picker.value);
      // Hand focus back so Space and the arrow keys drive playback again.
      this.picker.blur();
    });
    pickerLabel.append(this.picker);

    this.fpsReadout = el('output', 'fps-readout', '');
    this.fpsReadout.setAttribute('aria-label', 'Frame rate');

    const hint = el('div', 'hint');
    hint.innerHTML =
      '<kbd>Space</kbd> play/pause <span class="sep">·</span> <kbd>←</kbd><kbd>→</kbd> frame ' +
      '<span class="sep">·</span> <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> 1 s <span class="sep">·</span> ' +
      '<kbd>Home</kbd><kbd>End</kbd>';

    info.append(pickerLabel, this.fpsReadout, el('span', 'spacer'), hint);
    this.element.append(transport, info);
    host.appendChild(this.element);

    this.setPlaying(false, false);
  }

  setScenes(options: readonly SceneOption[], selected: string | null): void {
    const signature = JSON.stringify(options);
    if (signature !== this.sceneSignature) {
      this.sceneSignature = signature;
      this.picker.replaceChildren(
        ...options.map((o) => {
          const option = document.createElement('option');
          option.value = o.key;
          option.textContent = o.invalid ? `${o.label} (invalid)` : o.label;
          option.title = o.file;
          return option;
        }),
      );
      this.picker.disabled = options.length === 0;
    }
    if (selected !== null && this.picker.value !== selected) this.picker.value = selected;
  }

  setTimeline(readout: TimelineReadout | null): void {
    if (!readout) {
      this.scrubber.disabled = true;
      this.scrubber.max = '0';
      this.scrubber.value = '0';
      this.scrubber.style.setProperty('--progress', '0%');
      setText(this.timecode, '--:--:-- / --:--:--');
      setText(this.frameReadout, 'frame -');
      return;
    }
    const last = readout.frameCount - 1;
    this.scrubber.disabled = false;
    const max = String(last);
    if (this.scrubber.max !== max) this.scrubber.max = max;
    const value = String(readout.frame);
    if (this.scrubber.value !== value) this.scrubber.value = value;
    this.scrubber.style.setProperty('--progress', `${last > 0 ? (readout.frame / last) * 100 : 0}%`);
    setText(this.timecode, `${readout.timecode} / ${readout.endTimecode}`);
    setText(this.frameReadout, `frame ${readout.frame} of ${readout.frameCount}`);
  }

  /**
   * Shows the frame range [from, to) as a band on the scrubber, from the in
   * frame's slot to the out frame's (to - 1). The scrubber thumb centre sits
   * at frame / (frameCount - 1) of the track, inset by the thumb radius.
   */
  setRange(range: { from: number; to: number } | null, frameCount: number): void {
    this.band.hidden = range === null || frameCount < 1;
    if (!range || frameCount < 1) return;
    const last = frameCount - 1;
    const start = last > 0 ? (range.from - 0.5) / last : 0;
    const end = last > 0 ? (range.to - 0.5) / last : 1;
    this.band.style.setProperty('--in', String(start));
    this.band.style.setProperty('--out', String(end));
    this.band.title = `[${range.from}, ${range.to})`;
  }

  setPlaying(playing: boolean, enabled: boolean): void {
    this.playButton.disabled = !enabled;
    if (playing === this.playing) return;
    this.playing = playing;
    this.playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    const label = playing ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-label', label);
    this.playButton.title = `${label} (Space)`;
    this.element.classList.toggle('is-playing', playing);
  }

  setFps(sceneFps: number | null, measured: number | null): void {
    if (sceneFps === null) {
      setText(this.fpsReadout, '');
      return;
    }
    const live = measured === null ? '–' : measured.toFixed(1);
    setText(this.fpsReadout, `${sceneFps} fps · playback ${live}`);
  }
}
