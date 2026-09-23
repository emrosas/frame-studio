import type { EasingName } from './types';

type EaseFn = (u: number) => number;

const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;

/** Raw curves (easings.net formulas). Endpoints are pinned by `pinned` below. */
const raw: Record<EasingName, EaseFn> = {
  linear: (u) => u,
  inQuad: (u) => u * u,
  outQuad: (u) => 1 - (1 - u) * (1 - u),
  inOutQuad: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  inCubic: (u) => u * u * u,
  outCubic: (u) => 1 - Math.pow(1 - u, 3),
  inOutCubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  inQuart: (u) => u * u * u * u,
  outQuart: (u) => 1 - Math.pow(1 - u, 4),
  inOutQuart: (u) => (u < 0.5 ? 8 * u * u * u * u : 1 - Math.pow(-2 * u + 2, 4) / 2),
  inSine: (u) => 1 - Math.cos((u * Math.PI) / 2),
  outSine: (u) => Math.sin((u * Math.PI) / 2),
  inOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  inExpo: (u) => Math.pow(2, 10 * u - 10),
  outExpo: (u) => 1 - Math.pow(2, -10 * u),
  inOutExpo: (u) => (u < 0.5 ? Math.pow(2, 20 * u - 10) / 2 : (2 - Math.pow(2, -20 * u + 10)) / 2),
  inBack: (u) => C3 * u * u * u - C1 * u * u,
  outBack: (u) => 1 + C3 * Math.pow(u - 1, 3) + C1 * Math.pow(u - 1, 2),
  inOutBack: (u) =>
    u < 0.5
      ? (Math.pow(2 * u, 2) * ((C2 + 1) * 2 * u - C2)) / 2
      : (Math.pow(2 * u - 2, 2) * ((C2 + 1) * (u * 2 - 2) + C2) + 2) / 2,
};

/** Clamp to [0, 1] and return exact endpoints (inExpo(0) is 2^-10, not 0). NaN maps to 0. */
function pinned(fn: EaseFn): EaseFn {
  return (u) => {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    return fn(u);
  };
}

export const EASING_NAMES: readonly EasingName[] = Object.freeze(Object.keys(raw) as EasingName[]);

export const easings: Record<EasingName, (u: number) => number> = Object.freeze(
  Object.fromEntries(EASING_NAMES.map((name) => [name, pinned(raw[name])])) as Record<EasingName, EaseFn>,
);

/** Eased progress for u in [0, 1] (clamped). An undefined name is linear. */
export function ease(name: EasingName | undefined, u: number): number {
  return easings[name ?? 'linear'](u);
}
