// What the viewer does with a generated voice (ADR 0017).

/** A voice just saved in media/. `words` come from a provider that times its own speech. */
export interface GeneratedVoice {
  file: string;
  script: string;
  lang: string;
  words?: readonly { text: string; start: number; end: number }[];
}

/**
 * The one call after every Generate Voice, for the timing job (ADR 0016). It does nothing yet. When that job lands,
 * start it here, with the script as the known words.
 */
export function alignVoice(voice: GeneratedVoice): void {
  void voice;
}

/** "348 MB", for a download's size. */
export const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/** What the price line says for `length` characters at a provider's rate. */
export function priceLine(length: number, usdPer1000Characters: number): string {
  const usd = (length / 1000) * usdPer1000Characters;
  return `${usd < 0.01 ? 'Under $0.01' : `About $${usd.toFixed(2)}`} for ${length} characters`;
}
