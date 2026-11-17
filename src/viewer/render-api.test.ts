import { describe, expect, it } from 'vitest';
import { imageName, isImageFormat } from './render-api';

describe('image exports (ADR 0020)', () => {
  it('names a still after its scene, and a frame of a longer scene with its number', () => {
    expect(imageName('launch-1', 'png', 0, 1)).toBe('launch-1.png');
    expect(imageName('launch-1', 'jpg', 0, 1)).toBe('launch-1.jpg');
    expect(imageName('bear-test', 'png', 47, 96)).toBe('bear-test-00047.png');
    expect(imageName('bear-test', 'jpg', 0, 96)).toBe('bear-test-00000.jpg');
  });

  it('knows png and jpg', () => {
    expect(isImageFormat('png')).toBe(true);
    expect(isImageFormat('jpg')).toBe(true);
    expect(isImageFormat('jpeg')).toBe(false);
    expect(isImageFormat('mp4')).toBe(false);
    expect(isImageFormat(undefined)).toBe(false);
  });
});
