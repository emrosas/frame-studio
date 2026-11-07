// The network path a key takes (ADR 0017). A provider gets a fetch that reaches
// one origin only and never follows a redirect: fetch would carry a custom key
// header across origins on a redirect. Used by the app's main process only.

import type { ProviderFetch } from './types.ts';

export function pinnedFetch(origin: string, raw: typeof fetch = fetch): ProviderFetch {
  const pinned = new URL(origin).origin;
  return (path, init) => {
    const url = new URL(path, pinned);
    if (url.origin !== pinned) throw new Error(`A provider tried to reach ${url.origin}, outside its pinned ${pinned}.`);
    return raw(url, { ...init, redirect: 'error' });
  };
}

/** A loopback address, the one other place a test may point a provider. */
export const isLoopback = (origin: string): boolean => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
