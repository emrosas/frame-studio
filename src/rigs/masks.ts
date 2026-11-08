// The masks the timeline's transition presets write (ADR 0018). As a clip's
// mask, the clip shows only where these draw, so keying `progress` from 0 to 1
// opens onto it. They scale with the stage, and neither uses the rng, so a clip
// split in two cuts the same at any frame.

import type { Rig } from '../engine/types';
import { TAU } from './parts/math';
import { choice, num, readParams } from './parts/params';

const wipeParams = {
  progress: num(1, 0, 1, 'How much of the stage shows, 0 to 1. Key it from 0 to 1 to wipe on.'),
  from: choice('left', ['left', 'right', 'top', 'bottom'], 'The side it comes in from.'),
};

export const maskWipe: Rig = {
  id: 'mask-wipe',
  description: 'A straight wipe, for use as a mask: key progress from 0 to 1 to reveal a clip from one side.',
  params: wipeParams,
  draw(ctx, values, _t, _rng, stage) {
    const p = readParams(wipeParams, values);
    const progress = p.number('progress');
    const { width, height } = stage;
    const across = width * progress;
    const down = height * progress;
    const from = p.string('from');
    ctx.fillStyle = '#000000';
    if (from === 'left') ctx.fillRect(0, 0, across, height);
    else if (from === 'right') ctx.fillRect(width - across, 0, across, height);
    else if (from === 'top') ctx.fillRect(0, 0, width, down);
    else ctx.fillRect(0, height - down, width, down);
  },
};

const irisParams = {
  progress: num(1, 0, 1, 'How far the circle has opened, 0 to 1. At 1 it covers the stage from any centre.'),
  x: num(0.5, 0, 1, 'Centre across the stage, 0 to 1.'),
  y: num(0.5, 0, 1, 'Centre down the stage, 0 to 1.'),
};

export const maskIris: Rig = {
  id: 'mask-iris',
  description: 'A clean round opening, for use as a mask: key progress from 0 to 1 to open onto a clip.',
  params: irisParams,
  draw(ctx, values, _t, _rng, stage) {
    const p = readParams(irisParams, values);
    const progress = p.number('progress');
    const x = p.number('x') * stage.width;
    const y = p.number('y') * stage.height;
    const reach = Math.hypot(Math.max(x, stage.width - x), Math.max(y, stage.height - y));
    ctx.beginPath();
    ctx.arc(x, y, reach * progress, 0, TAU);
    ctx.fillStyle = '#000000';
    ctx.fill();
  },
};
