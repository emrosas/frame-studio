import { describe, expect, it } from 'vitest';
import type { TurnEvent, TurnEventBody } from '../studio/protocol';
import { describeUsage, foldTurn } from './transcript';

let seq = 0;
const ev = (body: TurnEventBody): TurnEvent => ({ ...body, seq: ++seq, at: '' }) as TurnEvent;

describe('foldTurn', () => {
  it('joins text between steps, keeps each step at its latest state, and groups frames', () => {
    seq = 0;
    const t = foldTurn([
      ev({ type: 'text', text: 'Looking ' }),
      ev({ type: 'text', text: 'at the ball.' }),
      ev({ type: 'step', id: 's1', label: 'Studio: render_frame', status: 'running' }),
      ev({ type: 'frame', file: 'frame-001.png', sceneId: 'hello', frame: 12 }),
      ev({ type: 'frame', file: 'frame-002.png', sceneId: 'hello', frame: 13 }),
      ev({ type: 'step', id: 's1', label: 'Studio: render_frame', status: 'done', detail: 'hello frame 12' }),
      ev({ type: 'text', text: ' Done.' }),
      ev({ type: 'usage', usage: { inputTokens: 1200, outputTokens: 80 } }),
    ]);
    expect(t.items).toEqual([
      { kind: 'text', text: 'Looking at the ball.' },
      { kind: 'step', id: 's1', label: 'Studio: render_frame', status: 'done', detail: 'hello frame 12' },
      { kind: 'frames', frames: [{ file: 'frame-001.png', frame: 12 }, { file: 'frame-002.png', frame: 13 }] },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(t.usage).toEqual({ inputTokens: 1200, outputTokens: 80 });
    expect(t.open).toBe(0);
  });

  it('shows approval cards with their answers, and counts the open ones', () => {
    seq = 0;
    const t = foldTurn([
      ev({ type: 'approval', id: 'a', kind: 'command', summary: 'Run a command', detail: 'npm test' }),
      ev({ type: 'approval', id: 'b', kind: 'write', summary: 'Edit src/engine/render.ts' }),
      ev({ type: 'approval-resolved', id: 'a', decision: 'decline' }),
      ev({ type: 'status', message: 'Resuming the session' }),
      ev({ type: 'error', message: 'claude exited' }),
    ]);
    expect(t.items).toEqual([
      { kind: 'approval', id: 'a', approvalKind: 'command', summary: 'Run a command', detail: 'npm test', decision: 'decline' },
      { kind: 'approval', id: 'b', approvalKind: 'write', summary: 'Edit src/engine/render.ts', decision: null },
      { kind: 'note', text: 'Resuming the session', error: false },
      { kind: 'note', text: 'claude exited', error: true },
    ]);
    expect(t.open).toBe(1);
  });

  it('orders by sequence, whatever order events arrived in', () => {
    const a = { type: 'text', text: 'first ', seq: 1, at: '' } as TurnEvent;
    const b = { type: 'text', text: 'second', seq: 2, at: '' } as TurnEvent;
    expect(foldTurn([b, a]).items).toEqual([{ kind: 'text', text: 'first second' }]);
  });
});

describe('describeUsage', () => {
  it('reads tokens in thousands, and cost when reported', () => {
    expect(describeUsage({ inputTokens: 1234, outputTokens: 340 })).toBe('1.2k in · 340 out');
    expect(describeUsage({ inputTokens: 45_000, outputTokens: 2000, costUsd: 0.0412 })).toBe('45k in · 2.0k out · $0.041');
  });
});

describe('question cards in a turn (ADR 0011)', () => {
  const at = '2026-10-01T12:00:00.000Z';
  const questions = [{ id: 'font', header: 'Font', question: 'Which typeface?', options: [{ label: 'Fraunces' }, { label: 'Inter' }] }];

  it('is open, and the one to show, until answered', () => {
    const open = foldTurn([{ seq: 1, at, type: 'questions', id: 'q1', questions }]);
    expect(open.items).toEqual([{ kind: 'questions', id: 'q1', questions, answers: undefined }]);
    expect(open.open).toBe(1);
    expect(open.asking?.id).toBe('q1');

    const answered = foldTurn([
      { seq: 1, at, type: 'questions', id: 'q1', questions },
      { seq: 2, at, type: 'questions-answered', id: 'q1', answers: { font: ['Fraunces'] } },
    ]);
    expect(answered.items).toEqual([{ kind: 'questions', id: 'q1', questions, answers: { font: ['Fraunces'] } }]);
    expect(answered.open).toBe(0);
    expect(answered.asking).toBeNull();
  });

  it('records a skipped card as answered with null', () => {
    const skipped = foldTurn([
      { seq: 1, at, type: 'questions', id: 'q1', questions },
      { seq: 2, at, type: 'questions-answered', id: 'q1', answers: null },
    ]);
    expect(skipped.items[0]).toMatchObject({ kind: 'questions', answers: null });
    expect(skipped.asking).toBeNull();
  });
});
