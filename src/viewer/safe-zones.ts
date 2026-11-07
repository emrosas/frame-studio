// The safe-zone guide for 9:16 scenes: where TikTok, Reels and Shorts lay their
// own interface over a vertical video. An SVG laid over the canvas in the
// viewer only. It never reaches render(), so no export can carry it. The
// numbers are rounded, in 1080x1920 scene pixels, and cover all three
// platforms, which change their layouts now and then; they're a guide, not a spec.

import { SAFE_INSET as INSET } from '../engine/safe-area';

const WIDTH = 1080;
const HEIGHT = 1920;
const SVG = 'http://www.w3.org/2000/svg';

function node<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

export class SafeZoneGuide {
  private readonly svg: SVGSVGElement;

  constructor(host: HTMLElement) {
    const { top, right, bottom, left } = INSET;
    const inner = { x: left, y: top, width: WIDTH - left - right, height: HEIGHT - top - bottom };
    this.svg = node('svg', { class: 'safe-zones', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, 'aria-hidden': 'true' });
    this.svg.append(
      node('path', { class: 'safe-shade', 'fill-rule': 'evenodd', d: `M0 0H${WIDTH}V${HEIGHT}H0Z M${inner.x} ${inner.y}h${inner.width}v${inner.height}h-${inner.width}Z` }),
      node('rect', { class: 'safe-edge', ...inner }),
      node('text', { class: 'safe-label', x: WIDTH / 2, y: top / 2 + 14, 'text-anchor': 'middle' }, 'Account and tabs'),
      node('text', { class: 'safe-label', x: WIDTH / 2, y: HEIGHT - bottom / 2 + 14, 'text-anchor': 'middle' }, 'Caption and name'),
      node('text', { class: 'safe-label', x: WIDTH - right / 2 + 14, y: HEIGHT / 2, 'text-anchor': 'middle', transform: `rotate(90 ${WIDTH - right / 2} ${HEIGHT / 2})` }, 'Buttons'),
    );
    this.svg.style.display = 'none';
    host.append(this.svg);
  }

  show(on: boolean): void {
    this.svg.style.display = on ? '' : 'none';
  }
}
