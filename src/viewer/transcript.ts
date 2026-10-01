// Folds a turn's events into what the thread view shows (ADR 0006): the
// agent's text in paragraphs between its steps, each step at its latest
// state, rendered frames grouped, approval cards with their answers, and
// question cards (ADR 0011).
// Pure, so it is unit tested without a browser.

import type { AgentQuestion, ApprovalDecision, ApprovalKind, QuestionAnswers, TurnEvent, TurnUsage } from '../studio/protocol';

export type TranscriptItem =
  | { kind: 'text'; text: string }
  | { kind: 'step'; id: string; label: string; status: 'running' | 'done' | 'failed'; detail?: string }
  | { kind: 'frames'; frames: { file: string; frame: number }[] }
  | { kind: 'approval'; id: string; approvalKind: ApprovalKind; summary: string; detail?: string; decision: ApprovalDecision | null }
  /** answers: undefined while it waits for the user, null when it went unanswered. */
  | { kind: 'questions'; id: string; questions: AgentQuestion[]; answers: QuestionAnswers | null | undefined }
  | { kind: 'note'; text: string; error: boolean };

export interface Transcript {
  items: TranscriptItem[];
  usage: TurnUsage | null;
  /** Approval and question cards still waiting for an answer. */
  open: number;
  /** The question card waiting for the user, if any: the panel shows it above the composer. */
  asking: Extract<TranscriptItem, { kind: 'questions' }> | null;
}

export function foldTurn(events: readonly TurnEvent[]): Transcript {
  const items: TranscriptItem[] = [];
  const steps = new Map<string, Extract<TranscriptItem, { kind: 'step' }>>();
  const approvals = new Map<string, Extract<TranscriptItem, { kind: 'approval' }>>();
  const cards = new Map<string, Extract<TranscriptItem, { kind: 'questions' }>>();
  let usage: TurnUsage | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const last = items[items.length - 1];
    switch (e.type) {
      case 'text':
        if (last?.kind === 'text') last.text += e.text;
        else items.push({ kind: 'text', text: e.text });
        break;
      case 'step': {
        const step = steps.get(e.id);
        if (step) {
          step.label = e.label;
          step.status = e.status;
          if (e.detail !== undefined) step.detail = e.detail;
        } else {
          const item = { kind: 'step' as const, id: e.id, label: e.label, status: e.status, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
          steps.set(e.id, item);
          items.push(item);
        }
        break;
      }
      case 'frame':
        if (last?.kind === 'frames') last.frames.push({ file: e.file, frame: e.frame });
        else items.push({ kind: 'frames', frames: [{ file: e.file, frame: e.frame }] });
        break;
      case 'approval': {
        const item = { kind: 'approval' as const, id: e.id, approvalKind: e.kind, summary: e.summary, ...(e.detail ? { detail: e.detail } : {}), decision: null };
        approvals.set(e.id, item);
        items.push(item);
        break;
      }
      case 'approval-resolved': {
        const card = approvals.get(e.id);
        if (card) card.decision = e.decision;
        break;
      }
      case 'questions': {
        const item = { kind: 'questions' as const, id: e.id, questions: e.questions, answers: undefined };
        cards.set(e.id, item);
        items.push(item);
        break;
      }
      case 'questions-answered': {
        const card = cards.get(e.id);
        if (card) card.answers = e.answers;
        break;
      }
      case 'usage':
        usage = e.usage;
        break;
      case 'status':
        items.push({ kind: 'note', text: e.message, error: false });
        break;
      case 'error':
        items.push({ kind: 'note', text: e.message, error: true });
        break;
    }
  }
  for (const item of items) if (item.kind === 'text') item.text = item.text.trim();
  const asking = [...cards.values()].filter((c) => c.answers === undefined);
  return {
    items: items.filter((i) => i.kind !== 'text' || i.text !== ''),
    usage,
    open: [...approvals.values()].filter((a) => a.decision === null).length + asking.length,
    asking: asking.at(-1) ?? null,
  };
}

/** "1.2k in · 340 out", with the cost when the provider reports one. */
export function describeUsage(usage: TurnUsage): string {
  const n = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(v));
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${n(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${n(usage.outputTokens)} out`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`);
  return parts.join(' · ');
}
