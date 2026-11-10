/**
 * The text checks that need no pixels, over every scene in the repo: where its
 * text sits and how long it stays. The repo's text lives in type-test, a type
 * specimen with no motion, so most of these pass. What it does find is pinned
 * here as a real finding rather than tuned away. Contrast needs the render
 * worker, so tests/browser/check.test.ts covers it.
 */
import { describe, expect, it } from 'vitest';
import { frameCount } from '../src/engine';
import { textLayoutChecks } from '../src/export/text-check';
import { textAppearances } from '../src/export/text-marks';
import { diskLibrary } from './disk-library';

const library = diskLibrary();

describe('text checks over the repo', () => {
  for (const entry of library.entries) {
    it(entry.key, () => {
      expect(entry.errors).toEqual([]);
      const scene = entry.scene!;
      const appearances = textAppearances(scene, entry.registry!, entry.world);
      const results = textLayoutChecks(appearances, scene.size, scene.fps, 0, frameCount(scene));
      const found = Object.fromEntries(results.filter((r) => r.status !== 'pass').map((r) => [r.id, r.message]));
      if (entry.key === 'type-test') {
        // A specimen sheet of four seconds: the typing line finishes at 3 s, and the paragraph has 24 words.
        expect(found).toEqual({
          'reading-time': expect.stringMatching(/^"A paragraph wraps at a width, a…" \(paragraph\) reads for 4 s and needs 7\.2 s\. "\$ npm run typeface -- --builtins" \(typed\) reads for 1 s and needs 1\.8 s\.$/),
        });
        return;
      }
      expect(found).toEqual({});
    });
  }
});
