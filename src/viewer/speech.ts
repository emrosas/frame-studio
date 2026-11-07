// What the Generate Voice sheet works out (ADR 0017).

import type { PlacedVoice } from '../studio/protocol';

/** A voice just saved in media/. */
export type GeneratedVoice = PlacedVoice & { file: string };

/** "348 MB", for a download's size. */
export const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/** What the price line says for `length` characters at a provider's rate. */
export function priceLine(length: number, usdPer1000Characters: number): string {
  const usd = (length / 1000) * usdPer1000Characters;
  return `${usd < 0.01 ? 'Under $0.01' : `About $${usd.toFixed(2)}`} for ${length} characters`;
}
