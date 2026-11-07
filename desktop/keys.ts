// Provider keys (ADR 0017). Rigs and generators are code, and they run in the
// viewer page and the server process, so a key may reach neither: this file
// runs in the app's main process only. Keys sit in userData/keys.json as
// safeStorage ciphertext, mode 0600. Reading one back is for the moment of a
// request; everything else sees the provider, the last four and the date.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The part of Electron's safeStorage this needs. */
export interface KeyCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  /** Linux only: which secret store it found. "basic_text" means none. */
  getSelectedStorageBackend?(): string;
}

/** What may leave main. */
export interface KeySummary {
  provider: string;
  last4: string;
  /** When it was added, as an ISO date. */
  added: string;
}

interface StoredKey extends Omit<KeySummary, 'provider'> {
  cipher: string;
  /** For a provider with a host of the user's own, such as a local server. None does yet. */
  baseUrl?: string;
}

interface KeyFile {
  version: 1;
  keys: Record<string, StoredKey>;
}

const LONGEST = 512;

/** A key refused for a reason written here, in fixed words that never quote it. Anything else that fails says nothing. */
export class KeyRefused extends Error {}

export class KeyStore {
  private readonly file: string;
  private readonly cipher: KeyCipher;

  constructor(file: string, cipher: KeyCipher) {
    this.file = file;
    this.cipher = cipher;
  }

  /** Why keys can't be kept here, or null when they can. */
  refusal(): string | null {
    if (!this.cipher.isEncryptionAvailable()) return 'This computer has no secure storage for keys, so Frame Studio won\'t keep one.';
    if (process.platform === 'linux' && this.cipher.getSelectedStorageBackend?.() === 'basic_text') return 'This computer has no system keyring, so a key would be stored in plain text. Frame Studio won\'t keep one.';
    return null;
  }

  private async read(): Promise<KeyFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, keys: {} };
      // Anything else isn't "no keys": treating it so would let the next save wipe them.
      throw new KeyRefused('Frame Studio can\'t read its key file. Check its permissions and try again.');
    }
    try {
      const parsed = JSON.parse(text) as Partial<KeyFile>;
      if (typeof parsed.keys === 'object' && parsed.keys !== null && !Array.isArray(parsed.keys)) return { version: 1, keys: parsed.keys };
    } catch {
      // Falls through to moving it aside.
    }
    // Damaged. Kept beside it, ciphertext and all, so adding a key again loses nothing.
    await rename(this.file, `${this.file}.damaged-${Date.now()}`).catch(() => {});
    return { version: 1, keys: {} };
  }

  private async write(file: KeyFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const partial = `${this.file}.partial`;
    await writeFile(partial, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(partial, 0o600);
    await rename(partial, this.file);
  }

  async list(): Promise<KeySummary[]> {
    const { keys } = await this.read().catch((): KeyFile => ({ version: 1, keys: {} }));
    return Object.entries(keys).map(([provider, { last4, added }]) => ({ provider, last4, added }));
  }

  async save(provider: string, key: string): Promise<void> {
    const problem = this.refusal();
    if (problem) throw new KeyRefused(problem);
    const clean = key.trim();
    if (clean.length < 8 || clean.length > LONGEST || !/^[\x21-\x7e]+$/.test(clean)) throw new KeyRefused('That doesn\'t look like an API key. Paste the whole key, with no spaces.');
    const file = await this.read();
    file.keys[provider] = { cipher: this.cipher.encryptString(clean).toString('base64'), last4: clean.slice(-4), added: new Date().toISOString().slice(0, 10) };
    await this.write(file);
  }

  /** The key itself. For the one request about to use it; nothing keeps the result. */
  async reveal(provider: string): Promise<string | null> {
    const problem = this.refusal();
    if (problem) throw new Error(problem);
    const stored = (await this.read()).keys[provider];
    return stored ? this.cipher.decryptString(Buffer.from(stored.cipher, 'base64')) : null;
  }

  async remove(provider: string): Promise<void> {
    const file = await this.read();
    delete file.keys[provider];
    await this.write(file);
  }
}
