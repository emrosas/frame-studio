// Pairing (ADR 0008). Whoever starts the studio server gives it a token. A
// page trades the token once for an HttpOnly, SameSite=Strict cookie; tools
// send the token as a bearer token. The cookie holds a secret derived from the
// token, so a server restarted with the same token (npm run dev keeps one)
// accepts the same cookie. Node only.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The session cookie's name; the server's port follows it, since browsers share cookies across ports. */
export const COOKIE = 'frame_studio_session';

/** A fresh pairing token: 24 random bytes. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** One cookie's value, or undefined. Other apps on 127.0.0.1 share the jar, so a malformed one is skipped, not fatal. */
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class Pairing {
  private readonly token: string;
  private readonly session: string;
  private name = COOKIE;

  constructor(token: string) {
    if (token.length < 16) throw new Error('A pairing token needs at least 16 characters.');
    this.token = token;
    this.session = createHmac('sha256', token).update('frame-studio session').digest('base64url');
  }

  /** Names the cookie after the server's port, so two servers paired in one browser keep their own. */
  setPort(port: number): void {
    this.name = `${COOKIE}_${port}`;
  }

  /** The cookie's name. */
  get cookieName(): string {
    return this.name;
  }

  /** True for the pairing token itself. */
  isToken(value: string): boolean {
    return same(value, this.token);
  }

  /** True when the request carries the session cookie or the token as a bearer token. */
  allows(req: IncomingMessage): boolean {
    const auth = String(req.headers.authorization ?? '');
    if (auth.startsWith('Bearer ') && this.isToken(auth.slice('Bearer '.length))) return true;
    const value = cookie(req, this.name);
    return value !== undefined && same(value, this.session);
  }

  /** Sets the session cookie on a response. */
  setCookie(res: ServerResponse): void {
    res.setHeader('Set-Cookie', `${this.name}=${this.session}; HttpOnly; SameSite=Strict; Path=/`);
  }
}
