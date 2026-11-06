// The New dialog's formats and looks. A pixel short draws on a 180x320 stage
// shown at 1080x1920, the grid Science in 8bit's films measure at, snapped to
// one of the looks below. The palettes are our own, each sixteen colours.

export interface FormatPreset {
  id: string;
  label: string;
  hint: string;
  size: readonly [number, number];
  fps: number;
  duration: number;
  /** Output pixels per stage pixel, for a pixel stage. */
  pixelScale?: number;
}

export const FORMATS: readonly FormatPreset[] = [
  { id: 'short', label: 'Short', hint: '9:16', size: [1080, 1920], fps: 30, duration: 40 },
  { id: 'pixel', label: 'Pixel short', hint: '180×320', size: [1080, 1920], fps: 30, duration: 40, pixelScale: 6 },
  { id: 'landscape', label: 'Landscape', hint: '16:9', size: [1920, 1080], fps: 24, duration: 10 },
  { id: 'square', label: 'Square', hint: '1:1', size: [1080, 1080], fps: 30, duration: 10 },
];

/** How much a pixel short dithers between its look's colours. */
export const PIXEL_DITHER = 0.5;

export interface Look {
  id: string;
  name: string;
  palette: readonly string[];
}

export const LOOKS: readonly Look[] = [
  {
    id: 'arcade',
    name: 'Arcade',
    palette: ['#0b0a1f', '#1a1440', '#2d1b69', '#4b2a8c', '#7a3bb0', '#c04cc8', '#ff5fa2', '#ff8a5c', '#ffc75f', '#fff3b0', '#6ce5e8', '#2fb4d9', '#1f6fb2', '#164a7a', '#f4f1ff', '#8a8fb5'],
  },
  {
    id: 'lab',
    name: 'Lab',
    palette: ['#0a1413', '#12302b', '#1c4a3f', '#2a6b53', '#3f8f63', '#68b36d', '#a3d17a', '#dcec9a', '#f7fbe1', '#fbd35c', '#f28f3b', '#c8553d', '#7a2e3a', '#3b2a4a', '#5fa8c7', '#b7e3e6'],
  },
  {
    id: 'desert',
    name: 'Desert',
    palette: ['#1e1510', '#3a2618', '#5c3a22', '#83562f', '#ad7a3f', '#d3a45a', '#eccb82', '#f7e7bd', '#fdf8ea', '#b8d4c8', '#6fa8a1', '#3f7a80', '#2b4f5e', '#a8432e', '#dc6b3f', '#f2a65a'],
  },
  {
    id: 'harbour',
    name: 'Harbour',
    palette: ['#0e1420', '#1b2536', '#2c3a52', '#43566f', '#64798f', '#93a6b2', '#c7d2d0', '#f1efe3', '#f6c98b', '#ee9a5e', '#d9623f', '#a83c3e', '#6d2a45', '#3f5f7f', '#3c8d93', '#8fd0c0'],
  },
];
