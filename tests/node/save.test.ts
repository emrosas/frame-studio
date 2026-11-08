/**
 * Saving a generated file when the disk misbehaves (ADR 0017): no hard links,
 * and a write that fails partway. tests/node/voice.test.ts has the usual paths.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ link: null as string | null, write: false }));

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (from: string, to: string) => {
      if (faults.link) throw Object.assign(new Error('no links here'), { code: faults.link });
      return real.link(from, to);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (!faults.write) return real.writeFile(...args);
      await real.writeFile(args[0], 'half', args[2]);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
  };
});

const { saveVoiceFile } = await import('../../tools/voice/save');

const dir = mkdtempSync(join(tmpdir(), 'frame-studio-save-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  faults.link = null;
  faults.write = false;
});

describe('saving on a disk that misbehaves', () => {
  it.each(['ENOTSUP', 'EPERM', 'ENOSYS'])('copies when linking fails with %s, and still never overwrites', async (code) => {
    faults.link = code;
    const root = mkdtempSync(join(dir, 'copy-'));
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-07T12:00:00Z') });
    try {
      const first = await saveVoiceFile(root, 'test', '.mp3', new Uint8Array([1]));
      const second = await saveVoiceFile(root, 'test', '.mp3', new Uint8Array([2]));
      expect(second).not.toBe(first);
      expect(readFileSync(join(root, first))[0]).toBe(1);
      expect(readFileSync(join(root, second))[0]).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    expect(readdirSync(join(root, 'media')).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('leaves nothing behind when the write fails', async () => {
    faults.write = true;
    const root = mkdtempSync(join(dir, 'full-'));
    mkdirSync(join(root, 'media'));
    await expect(saveVoiceFile(root, 'test', '.mp3', new Uint8Array([1]))).rejects.toThrow('disk full');
    expect(readdirSync(join(root, 'media'))).toEqual([]);
  });
});
