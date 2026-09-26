// Pairs the page with its studio server (ADR 0008). The token comes from the
// URL fragment (#token=..., as npm run dev prints it) or from the desktop
// bridge. The server answers with an HttpOnly cookie, and the fragment is
// removed so the token doesn't linger in the address or history.

import { desktop } from './desktop';

export type Paired = { ok: true; folder: string } | { ok: false; reason: string };

export async function pair(): Promise<Paired> {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = params.get('token');
  if (fromUrl !== null) {
    params.delete('token');
    const rest = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  }
  const token = fromUrl ?? desktop()?.token ?? null;
  try {
    if (token !== null) {
      const res = await fetch('/__studio/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!res.ok) return { ok: false, reason: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The studio server answered ${res.status}.` };
    }
    const health = (await (await fetch('/__studio/health')).json()) as { folder?: string };
    if (health.folder !== undefined) return { ok: true, folder: health.folder };
    return { ok: false, reason: 'This page is not paired with the studio server. Open the link npm run dev printed (it ends in #token=...), or the app.' };
  } catch (err) {
    return { ok: false, reason: `The studio server did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}
