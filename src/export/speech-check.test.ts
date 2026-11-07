import { describe, expect, it } from 'vitest';
import { createRegistry } from '../engine/registry';
import { anchorWords } from '../engine/speech';
import type { Scene, SpokenWord } from '../engine/types';
import { captions } from '../rigs/type/captions';
import { paper } from '../rigs/paper';
import { checkMarkers } from './check';
import { checkOrphans, checkWordSync, speechChecks } from './speech-check';

const words = (n: number, each: number): SpokenWord[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, text: 'palabra', start: i * each, end: (i + 1) * each }));
const registry = createRegistry([paper, captions]);
const scene = (over: Partial<Scene> = {}, lang = 'es', cueWords = words(8, 0.5)): Scene => ({
  id: 's',
  fps: 12,
  duration: 8,
  size: [1080, 1920],
  seed: 1,
  layers: [{ id: 'subs', rig: 'captions', params: { cue: 'voice' } }],
  audio: [{ id: 'voice', file: 'media/v.mp3', start: 0, end: 8, lang, words: cueWords }],
  ...over,
});
const find = (s: Scene, id: string) => speechChecks(s, registry, {}, 0, 96).find((c) => c.id === id)!;

describe('word-sync', () => {
  it('passes anchors on their words', () => {
    const s = anchorWords(scene({ markers: [{ t: 0, label: 'lock!', word: 'voice#w3' }] }));
    expect(checkWordSync(s, 0, 96)).toMatchObject({ status: 'pass', message: '1 anchor sits on its word.' });
  });

  it('fails a key a held layer shows too late', () => {
    const s = anchorWords(scene({ layers: [{ id: 'a', rig: 'paper', stepFps: 1, tracks: [{ param: 'tone', keys: [{ t: 0, v: '#fff', word: 'voice#w1' }] }] }] }));
    expect(checkWordSync(s, 0, 96).status).toBe('fail');
  });

  it('warns when the word under an anchor was a guess', () => {
    const unsure = words(8, 0.5).map((w, i) => (i === 3 ? { ...w, p: 0.2 } : w));
    const s = anchorWords(scene({ markers: [{ t: 0, label: 'lock!', word: 'voice#w3' }] }, 'es', unsure));
    expect(checkWordSync(s, 0, 96).status).toBe('warn');
  });

  it('leaves a marker on a word out of the onset test: a word in mid sentence starts no new sound', () => {
    const markers = [{ t: 1, label: 'lock!', word: 'voice#w2' }];
    expect(checkMarkers(markers, [], 12, 0, 96).status).toBe('pass');
  });
});

describe('word-orphans', () => {
  it('reports what lost its word, and where it stayed', () => {
    const result = checkOrphans(scene({ markers: [{ t: 3, label: 'lock', word: 'voice#gone' }] }));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('marker "lock" lost voice#gone and stays at 3 s');
  });
});

describe('caption-speed', () => {
  // Between the two ceilings: about 19.6 characters a second.
  const quick = words(18, 0.4);

  it('holds Spanish to the slower ceiling', () => {
    expect(find(scene({}, 'es', quick), 'caption-speed').status).toBe('warn');
    expect(find(scene({}, 'en', quick), 'caption-speed').status).toBe('pass');
  });

  it('passes a voice at a reading pace', () => {
    expect(find(scene(), 'caption-speed').status).toBe('pass');
  });
});

describe('caption-safe', () => {
  it('passes the rig where it sits by default', () => {
    expect(find(scene(), 'caption-safe').status).toBe('pass');
  });

  it('warns when it is pushed under the platform buttons', () => {
    const s = scene({ layers: [{ id: 'subs', rig: 'captions', params: { cue: 'voice', offsetY: 300 } }] });
    expect(find(s, 'caption-safe').status).toBe('warn');
  });

  it('fails captions on a cue with no words', () => {
    const s = scene({ audio: [{ id: 'voice', file: 'media/v.mp3', start: 0, end: 8 }] });
    expect(find(s, 'caption-safe')).toMatchObject({ status: 'fail' });
    expect(find(s, 'caption-safe').message).toContain('align_voice');
  });

  it('has nothing to say about a scene without captions', () => {
    expect(find(scene({ layers: [] }), 'caption-safe').message).toBe('There are no captions.');
  });
});
