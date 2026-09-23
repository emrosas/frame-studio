export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
