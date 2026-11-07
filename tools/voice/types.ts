// What a generation provider is (ADR 0017). One file each in providers/, added
// by pull request and loaded by the app's main process, never from a project
// folder, since a provider holds a key while it runs. 'video' is in the type so
// Generate Video fits later: its results land in media/ as composition clips
// (ADR 0014), never in scenes. Nothing builds it yet.

export type GenerationKind = 'voice' | 'video';

export interface VoiceOption {
  id: string;
  label: string;
  /** Language codes it speaks, such as "en" and "es". */
  langs: readonly string[];
  /** A short note for the voice list. */
  detail?: string;
}

export interface GenerateRequest {
  kind: GenerationKind;
  text: string;
  lang: string;
  voice: string;
}

/** A spoken word, in seconds into the file. */
export interface GeneratedWord {
  text: string;
  start: number;
  end: number;
}

export interface Generated {
  bytes: Uint8Array;
  /** The file's extension, with its dot. The caller picks the name. */
  ext: string;
  words?: GeneratedWord[];
}

/** A job the provider runs for a while: ask again after `after` ms. Video providers will need it; voice answers at once. */
export interface Pending {
  pending: true;
  after: number;
  poll(): Promise<Generated | Pending>;
}

/** The only way a provider reaches the network: a path on its own host. See pinned.ts. */
export type ProviderFetch = (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export interface Provider {
  id: string;
  label: string;
  /** The one host its key may be sent to. */
  host: string;
  /** Where to make, cap and revoke a key. */
  keyPage: string;
  kinds: readonly GenerationKind[];
  /** An estimate for the confirmation dialog. The provider's own bill decides the real cost. */
  price: { usdPer1000Characters: number };
  voices: readonly VoiceOption[];
  generate(request: GenerateRequest, key: string, http: ProviderFetch): Promise<Generated | Pending>;
}

/** A provider's reply that wasn't a success. Carries the status code alone: bodies stay out of errors and logs. */
export class ProviderError extends Error {
  readonly status: number;

  constructor(label: string, status: number) {
    super(status === 401 || status === 403 ? `${label} refused the key (${status}).` : status === 429 ? `${label} says the account is out of quota or busy (429).` : `${label} answered ${status}.`);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** Waits out a pending job, then returns what it made. */
export async function finished(outcome: Generated | Pending, wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<Generated> {
  let now = outcome;
  while ('pending' in now) {
    await wait(now.after);
    now = await now.poll();
  }
  return now;
}

/** "about $0.03" for `text` at the provider's rate. */
export function estimate(provider: Pick<Provider, 'price'>, text: string): string {
  const usd = (text.length / 1000) * provider.price.usdPer1000Characters;
  return usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`;
}
