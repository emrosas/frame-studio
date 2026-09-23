import { describe, expect, it } from 'vitest';
import { bootUrlState, parseFrameParam, readUrlState, reloadRecord, urlWith } from './url';

const EMPTY_SELECTION = { layer: null, part: null, from: null, to: null };

describe('readUrlState', () => {
  it('reads scene and frame', () => {
    expect(readUrlState('?scene=fly-test&frame=47')).toEqual({ scene: 'fly-test', frame: '47', ...EMPTY_SELECTION });
    expect(readUrlState('')).toEqual({ scene: null, frame: null, ...EMPTY_SELECTION });
  });

  it('reads the selection: layer, part, from and to', () => {
    expect(readUrlState('?scene=bears&frame=3&layer=red&part=nose&from=2&to=10')).toEqual({
      scene: 'bears',
      frame: '3',
      layer: 'red',
      part: 'nose',
      from: '2',
      to: '10',
    });
  });
});

describe('parseFrameParam', () => {
  it('accepts frame numbers and clamps them', () => {
    expect(parseFrameParam('47', 12, 120)).toBe(47);
    expect(parseFrameParam('500', 12, 120)).toBe(119);
  });

  it('accepts timecodes', () => {
    expect(parseFrameParam('00:03:05', 12, 120)).toBe(41);
  });

  it('returns null for absent or unreadable values', () => {
    expect(parseFrameParam(null, 12, 120)).toBeNull();
    expect(parseFrameParam('abc', 12, 120)).toBeNull();
    expect(parseFrameParam('-3', 12, 120)).toBeNull();
    expect(parseFrameParam('1:2', 12, 120)).toBeNull();
  });
});

describe('urlWith', () => {
  it('sets scene and frame and keeps other params and the hash', () => {
    expect(urlWith('http://localhost:5173/?mode=x#h', { scene: 'fly-test', frame: 12 })).toBe('/?mode=x&scene=fly-test&frame=12#h');
    expect(urlWith('http://localhost:5173/?scene=a&frame=3', { scene: 'b', frame: 0 })).toBe('/?scene=b&frame=0');
    expect(urlWith('http://localhost:5173/?scene=a&frame=3', { scene: null, frame: null })).toBe('/');
  });

  it('writes the selection after scene and frame, and removes what is not set', () => {
    const full = { scene: 'bears', frame: 4, layer: 'red', part: 'nose', from: 2, to: 10 };
    expect(urlWith('http://localhost:5173/', full)).toBe('/?scene=bears&frame=4&layer=red&part=nose&from=2&to=10');
    const cleared = urlWith('http://localhost:5173/?scene=bears&frame=4&layer=red&part=nose&from=2&to=10&mode=x', {
      scene: 'bears',
      frame: 4,
      layer: null,
      part: null,
      from: null,
      to: null,
    });
    expect(cleared).toBe('/?scene=bears&frame=4&mode=x');
    // Omitted selection fields are removed too.
    expect(urlWith('http://localhost:5173/?scene=a&layer=x', { scene: 'a', frame: 1 })).toBe('/?scene=a&frame=1');
  });

  it('round-trips a selection through readUrlState, including ids that need escaping', () => {
    const pos = { scene: 'my scene', frame: '00:01:02', layer: 'bear & co', part: 'left?ear', from: 3, to: 9 };
    const href = urlWith('http://localhost:5173/', pos);
    expect(readUrlState(href.slice(href.indexOf('?')))).toEqual({
      scene: 'my scene',
      frame: '00:01:02',
      layer: 'bear & co',
      part: 'left?ear',
      from: '3',
      to: '9',
    });
  });
});

describe('bootUrlState', () => {
  // The URL a reload keeps can trail the screen by one throttled write; pagehide stores the position on screen.
  const url = { scene: 'hello', frame: '11', ...EMPTY_SELECTION };

  it('on a reload, takes the frame stored at pagehide for the same scene', () => {
    expect(bootUrlState(url, reloadRecord({ scene: 'hello', frame: 14 }), 'reload')).toEqual({ ...url, frame: '14' });
    expect(bootUrlState(url, reloadRecord({ scene: 'hello', frame: '00:01:02' }), 'reload')).toEqual({ ...url, frame: '00:01:02' });
  });

  it('on a reload, takes the selection stored at pagehide, including a cleared one', () => {
    const stored = reloadRecord({ scene: 'hello', frame: 14, layer: 'ball', part: null, from: 2, to: 20 });
    expect(bootUrlState(url, stored, 'reload')).toEqual({ scene: 'hello', frame: '14', layer: 'ball', part: null, from: '2', to: '20' });
    const withSelection = { ...url, layer: 'ball', part: 'x', from: '1', to: '5' };
    const cleared = reloadRecord({ scene: 'hello', frame: 14, layer: null, part: null, from: null, to: null });
    expect(bootUrlState(withSelection, cleared, 'reload')).toEqual({ ...url, frame: '14' });
  });

  it('keeps the URL selection when an older record has no selection fields', () => {
    const withSelection = { ...url, layer: 'ball', part: null, from: '1', to: '5' };
    expect(bootUrlState(withSelection, JSON.stringify({ scene: 'hello', frame: 14 }), 'reload')).toEqual({ ...withSelection, frame: '14' });
  });

  it('keeps the URL for other navigations, other scenes, or a bad record', () => {
    const stored = reloadRecord({ scene: 'hello', frame: 14, layer: 'ball' });
    expect(bootUrlState(url, stored, 'navigate')).toEqual(url);
    expect(bootUrlState(url, stored, 'back_forward')).toEqual(url);
    expect(bootUrlState(url, stored, undefined)).toEqual(url);
    expect(bootUrlState(url, reloadRecord({ scene: 'shapes-test', frame: 14 }), 'reload')).toEqual(url);
    expect(bootUrlState(url, reloadRecord({ scene: 'hello', frame: null }), 'reload')).toEqual(url);
    expect(bootUrlState(url, null, 'reload')).toEqual(url);
    expect(bootUrlState(url, '{not json', 'reload')).toEqual(url);
    expect(bootUrlState(url, '{"scene":"hello","frame":{}}', 'reload')).toEqual(url);
    expect(bootUrlState(url, '{"scene":"hello","frame":3,"layer":{}}', 'reload')).toEqual({ ...url, frame: '3' });
    const noScene = { scene: null, frame: null, ...EMPTY_SELECTION };
    expect(bootUrlState(noScene, stored, 'reload')).toEqual(noScene);
  });
});
