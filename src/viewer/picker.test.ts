import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../studio/protocol';
import { defaultEffort, defaultModel, effortsOf, fitSettings, liveRecents, MAX_RECENTS, parseRecents, pushRecent, type ModelPick } from './picker';

const claude: AgentStatus = {
  id: 'claude',
  label: 'Claude',
  ready: true,
  detail: 'Signed in',
  models: [
    { id: 'opus', label: 'Opus' },
    { id: 'default', label: 'Default', default: true, efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
  efforts: ['low', 'medium', 'high', 'max'],
};
const codex: AgentStatus = {
  id: 'codex',
  label: 'Codex',
  ready: false,
  detail: 'codex is not signed in',
  fix: 'codex login',
  models: [{ id: 'luna', label: 'Luna', efforts: ['low', 'ultra'], defaultEffort: 'ultra' }],
  efforts: ['low', 'ultra'],
};

describe('the model and effort that stand', () => {
  it('starts on the model the provider marks, else its first', () => {
    expect(defaultModel(claude)?.id).toBe('default');
    expect(defaultModel(codex)?.id).toBe('luna');
    expect(defaultModel({ models: [] })).toBeUndefined();
  });

  it("reads a model's own efforts, and its agent's when it lists none", () => {
    expect(effortsOf(claude, 'default')).toEqual(['low', 'medium', 'high']);
    expect(effortsOf(claude, 'opus')).toEqual(['low', 'medium', 'high', 'max']);
    expect(effortsOf(claude, 'haiku')).toEqual([]);
  });

  it("starts on the provider's effort, else medium, else the first", () => {
    expect(defaultEffort(codex, 'luna')).toBe('ultra');
    expect(defaultEffort(claude, 'default')).toBe('medium');
    expect(defaultEffort({ models: [], efforts: ['low', 'high'] }, undefined)).toBe('low');
  });

  it('keeps what the model takes and replaces the rest', () => {
    expect(fitSettings(claude, 'opus', 'max')).toEqual({ model: 'opus', effort: 'max' });
    expect(fitSettings(claude, 'default', 'max')).toEqual({ model: 'default', effort: 'medium' });
    expect(fitSettings(claude, 'gone', undefined)).toEqual({ model: 'default', effort: 'medium' });
    expect(fitSettings(claude, 'haiku', 'high')).toEqual({ model: 'haiku', effort: undefined });
  });

  it('leaves them be for an agent with no models', () => {
    expect(fitSettings({ models: [], efforts: [] }, 'opus', 'high')).toEqual({ model: undefined, effort: undefined });
  });
});

describe('recent picks', () => {
  it('puts a pick first, once, with its new effort', () => {
    const list = pushRecent([{ agent: 'claude', model: 'opus', effort: 'low' }, { agent: 'codex', model: 'luna' }], { agent: 'codex', model: 'luna', effort: 'ultra' });
    expect(list).toEqual([{ agent: 'codex', model: 'luna', effort: 'ultra' }, { agent: 'claude', model: 'opus', effort: 'low' }]);
  });

  it('keeps the same model of two agents apart', () => {
    expect(pushRecent([{ agent: 'claude', model: 'x' }], { agent: 'codex', model: 'x' })).toHaveLength(2);
  });

  it('keeps the last few', () => {
    let list = pushRecent([], { agent: 'claude', model: 'm0' });
    for (let i = 1; i < 9; i++) list = pushRecent(list, { agent: 'claude', model: `m${i}` });
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].model).toBe('m8');
  });

  it('reads back only what is a pick', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('not json')).toEqual([]);
    expect(parseRecents('{"agent":"claude"}')).toEqual([]);
    expect(parseRecents('[null,{"agent":"claude"},{"agent":"claude","model":"opus","effort":"low"}]')).toEqual([{ agent: 'claude', model: 'opus', effort: 'low' }]);
  });

  it('shows only picks that can still be made', () => {
    const list: ModelPick[] = [{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'gone' }, { agent: 'codex', model: 'luna' }];
    expect(liveRecents(list, [claude, codex])).toEqual([{ agent: 'claude', model: 'opus' }]);
    expect(liveRecents(list, [claude, { ...codex, ready: true }], 'codex')).toEqual([{ agent: 'codex', model: 'luna' }]);
  });
});
