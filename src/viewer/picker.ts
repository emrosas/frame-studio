// The model picker's rules, apart from its markup: which model and effort
// stand, and the last few picks.

import type { AgentId, AgentModel, AgentStatus } from '../studio/protocol';
import type { IconName } from './icons';

/** Where the last picks are kept. */
export const RECENTS_KEY = 'frame-studio:model-recents';
export const MAX_RECENTS = 5;

/** An agent, model and effort picked together. */
export interface ModelPick {
  agent: AgentId;
  model: string;
  effort?: string;
}

/** The provider's mark, or what stands for an agent that has none. */
export function agentIcon(id: AgentId): IconName {
  if (id === 'claude') return 'claude';
  if (id === 'codex') return 'openai';
  return id === 'external' ? 'terminal' : 'message';
}

/** The model a new thread starts on. */
export function defaultModel(status: Pick<AgentStatus, 'models'>): AgentModel | undefined {
  return status.models.find((m) => m.default) ?? status.models[0];
}

/** The efforts a model takes: its own, or its agent's when the provider doesn't say per model. */
export function effortsOf(status: Pick<AgentStatus, 'models' | 'efforts'>, modelId: string | undefined): string[] {
  return status.models.find((m) => m.id === modelId)?.efforts ?? status.efforts;
}

/** The effort a model starts on: the provider's word, else medium, else its first. */
export function defaultEffort(status: Pick<AgentStatus, 'models' | 'efforts'>, modelId: string | undefined): string | undefined {
  const efforts = effortsOf(status, modelId);
  const said = status.models.find((m) => m.id === modelId)?.defaultEffort;
  if (said && efforts.includes(said)) return said;
  return efforts.includes('medium') ? 'medium' : efforts[0];
}

/** A model and effort this agent offers, keeping what it can. An agent that lists no models runs its own default, so another agent's id never reaches it. */
export function fitSettings(status: Pick<AgentStatus, 'models' | 'efforts'>, model: string | undefined, effort: string | undefined): { model: string | undefined; effort: string | undefined } {
  if (status.models.length === 0) return { model: undefined, effort: effort !== undefined && status.efforts.includes(effort) ? effort : defaultEffort(status, undefined) };
  const fitted = status.models.some((m) => m.id === model) ? model : defaultModel(status)?.id;
  const efforts = effortsOf(status, fitted);
  return { model: fitted, effort: effort !== undefined && efforts.includes(effort) ? effort : defaultEffort(status, fitted) };
}

/** The list with this pick first, once. A model picked again takes its new effort. */
export function pushRecent(list: readonly ModelPick[], pick: ModelPick, max = MAX_RECENTS): ModelPick[] {
  return [pick, ...list.filter((p) => p.agent !== pick.agent || p.model !== pick.model)].slice(0, max);
}

/** The stored list, without anything that isn't a pick. */
export function parseRecents(text: string | null): ModelPick[] {
  try {
    const list = JSON.parse(text ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((p): p is ModelPick => typeof p?.agent === 'string' && typeof p?.model === 'string' && (p.effort === undefined || typeof p.effort === 'string'))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** The picks that can still be made: the agent is ready and offers the model. With `only`, that agent's alone. */
export function liveRecents(list: readonly ModelPick[], agents: readonly AgentStatus[], only?: AgentId): ModelPick[] {
  return list.filter((p) => {
    if (only !== undefined && p.agent !== only) return false;
    const status = agents.find((a) => a.id === p.agent);
    return status?.ready === true && status.models.some((m) => m.id === p.model);
  });
}
