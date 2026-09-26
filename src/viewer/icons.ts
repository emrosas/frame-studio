// The viewer's icons: stroked paths on a 24 px grid, drawn by Icon.svelte at
// 1.75 px. Filled ones (play, pause, stop) say so. No icon font or image
// files, like everything else in the studio.

const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;

export interface IconShape {
  d: string;
  filled?: boolean;
}

export const ICONS = {
  play: { d: 'M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z', filled: true },
  pause: { d: `${rect(6, 4.5, 4, 15, 1)}${rect(14, 4.5, 4, 15, 1)}`, filled: true },
  stop: { d: rect(6, 6, 12, 12, 2), filled: true },
  volume: { d: 'M11 5 6.5 9H3.5v6h3l4.5 4zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12' },
  mute: { d: 'M11 5 6.5 9H3.5v6h3l4.5 4zM16 9.5l5 5M21 9.5l-5 5' },
  plus: { d: 'M12 5v14M5 12h14' },
  close: { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' },
  send: { d: 'M12 19V5M5.5 11.5 12 5l6.5 6.5' },
  sidebar: { d: `${rect(3, 4, 18, 16, 2.5)}M9 4v16` },
  panel: { d: `${rect(3, 4, 18, 16, 2.5)}M15 4v16` },
  folder: { d: 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' },
  scene: { d: `${rect(3.5, 5, 17, 14, 2.5)}M10.5 9.5v5l4-2.5z` },
  project: { d: 'M12 4 20.5 8.5 12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5' },
  chevronDown: { d: 'M7 10l5 5 5-5' },
  back: { d: 'M19 12H5.5M11 6l-6 6 6 6' },
  export: { d: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13.5v4a2.5 2.5 0 0 0 2.5 2.5h9a2.5 2.5 0 0 0 2.5-2.5v-4' },
  keyboard: { d: `${rect(2.5, 6, 19, 12, 2.5)}M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8` },
  check: { d: 'M5 12.5l4.5 4.5L19 7.5' },
  revert: { d: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5' },
  retry: { d: 'M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 4v4.5h-4.5' },
  viewfinder: { d: 'M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15' },
  pointer: { d: 'M5 4.5 11.5 20l2.3-6.7 6.7-2.3z' },
  range: { d: 'M8 5H5v14h3M16 5h3v14h-3M9.5 12h5' },
  message: { d: 'M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.3A7.5 7.5 0 1 1 20 11.5z' },
  shot: { d: `${rect(3, 7, 18, 10, 2)}M7 7v10M17 7v10` },
} satisfies Record<string, IconShape>;

export type IconName = keyof typeof ICONS;
