import { describe, expect, it } from 'vitest';
import {
  canRevert,
  checkNewRequest,
  checkpointFileName,
  clipboardLine,
  describeTarget,
  displayStatus,
  firstRevertableTurn,
  normalizeRequest,
  requestFileName,
  STALL_MS,
  type StudioRequest,
  type Turn,
} from './protocol';

const selection = { sceneId: 'bear-test', layerId: 'pip', from: 24, to: 48 };

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    ask: { prompt: 'make pip sad here', references: [], selection, frame: 30, at: '2026-09-24T15:00:00.000Z' },
    status: 'pending',
    ...overrides,
  };
}

function thread(overrides: Partial<StudioRequest> = {}, turns: Turn[] = [turn()]): StudioRequest {
  return { id: 1, createdAt: '2026-09-24T15:00:00.000Z', status: 'pending', agent: 'external', sceneId: 'bear-test', turns, ...overrides };
}

describe('file names', () => {
  it('pads ids to four digits and grows past them', () => {
    expect(requestFileName(7)).toBe('0007.json');
    expect(requestFileName(12345)).toBe('12345.json');
    expect(requestFileName(7, 'claim')).toBe('0007.claim');
  });

  it("keeps turn 0's checkpoint under the name requests had before threads", () => {
    expect(checkpointFileName(7, 0)).toBe('0007.before.json');
    expect(checkpointFileName(7, 2)).toBe('0007.2.before.json');
  });
});

describe('displayStatus', () => {
  const now = Date.parse('2026-09-24T15:30:00.000Z');
  const at = (ms: number) => new Date(now - ms).toISOString();

  it("shows an external agent's turn working for longer than the stall time as stalled", () => {
    expect(displayStatus(thread({ status: 'working' }, [turn({ status: 'working', claimedAt: at(STALL_MS + 1000) })]), now)).toBe('stalled');
    expect(displayStatus(thread({ status: 'working' }, [turn({ status: 'working', claimedAt: at(STALL_MS - 1000) })]), now)).toBe('working');
    expect(displayStatus(thread({ status: 'your_turn' }), now)).toBe('your_turn');
  });

  it('never calls a studio agent stalled, since the studio knows whether it is alive', () => {
    expect(displayStatus(thread({ status: 'working', agent: 'claude' }, [turn({ status: 'working', claimedAt: at(STALL_MS * 3) })]), now)).toBe('working');
  });
});

describe('clipboardLine', () => {
  it('says what to do in one line any agent can follow', () => {
    const line = clipboardLine(thread({ id: 7 }));
    expect(line).toBe(
      'Frame Studio request #7: "make pip sad here" (bear-test, layer pip, frames [24, 48)). ' +
        'Read it with the frame-studio MCP tool get_request (id 7), then call complete_request when you are done.',
    );
    expect(line).not.toContain('\n');
  });

  it('describes the newest ask: a whole-range selection, references and its place in the thread', () => {
    const reply = turn({ ask: { prompt: 'redo\nthis', references: ['references/a.png'], selection: { sceneId: 's', from: 0, to: 4 }, frame: 1, at: '' } });
    const line = clipboardLine(thread({ id: 9 }, [turn({ status: 'done' }), reply]));
    expect(line).toContain('"redo this"');
    expect(line).toContain('(s, all layers, frames [0, 4), 1 reference image, reply 1 in the thread)');
  });
});

describe('describeTarget', () => {
  it('names a layer, a part, or the whole range', () => {
    expect(describeTarget({ sceneId: 's', layerId: 'pip', from: 0, to: 1 })).toBe('layer pip');
    expect(describeTarget({ sceneId: 's', layerId: 'pip', partId: 'mouth', from: 0, to: 1 })).toBe('layer pip › mouth');
    expect(describeTarget({ sceneId: 's', from: 0, to: 1 })).toBe('all layers');
  });
});

describe('canRevert', () => {
  const at = (minute: number) => `2026-09-24T15:${String(minute).padStart(2, '0')}:00.000Z`;
  /** A turn claimed at minute `claim`, with its checkpoint then, and done at `claim + 1`. */
  const done = (claim: number, extra: Partial<Turn> = {}): Turn =>
    turn({ status: 'done', checkpointAt: at(claim), claimedAt: at(claim), completedAt: at(claim + 1), ...extra });
  const one = (id: number, t: Turn, extra: Partial<StudioRequest> = {}) => thread({ id, status: 'your_turn', ...extra }, [t]);

  it('allows a finished turn with a checkpoint when nothing else touched the scene after it', () => {
    const all = [one(1, done(0)), one(2, done(5)), one(3, done(10), { sceneId: 'other' })];
    expect(canRevert(all[1], 0, all)).toBe(true);
    expect(canRevert(all[0], 0, all)).toBe(false);
    expect(canRevert(all[2], 0, all)).toBe(true);
    const failed = one(4, done(0, { status: 'failed' }));
    expect(canRevert(failed, 0, [failed])).toBe(true);
  });

  it("allows any turn of a thread: the thread's own later turns go with it", () => {
    const t = thread({ status: 'your_turn' }, [done(0), done(2), done(4)]);
    expect([0, 1, 2].map((k) => canRevert(t, k, [t]))).toEqual([true, true, true]);
    expect(canRevert(t, 3, [t])).toBe(false);
  });

  it('refuses while a turn of the thread is pending or working', () => {
    const t = thread({ status: 'pending' }, [done(0), turn()]);
    expect(canRevert(t, 0, [t])).toBe(false);
  });

  it('ignores later threads that are pending, cancelled or already reverted, so undo steps back one at a time', () => {
    const all = [one(1, done(0)), one(2, done(5, { status: 'reverted' })), one(3, turn()), one(4, turn({ status: 'cancelled' }))];
    expect(canRevert(all[0], 0, all)).toBe(true);
  });

  it('refuses without a checkpoint, or once reverted or cancelled', () => {
    expect(canRevert(one(1, done(0, { checkpointAt: undefined })), 0, [])).toBe(false);
    expect(canRevert(one(1, done(0, { status: 'reverted' })), 0, [])).toBe(false);
    expect(canRevert(one(1, done(0, { status: 'cancelled' })), 0, [])).toBe(false);
  });

  it('goes by time, not id: a turn claimed or finished after the checkpoint blocks it', () => {
    // Two sessions: #5 claimed first and finished last, #6 claimed and finished in between.
    const five = one(5, done(0, { completedAt: at(9) }));
    const six = one(6, done(3, { completedAt: at(4) }));
    expect(canRevert(six, 0, [five, six])).toBe(false);
    expect(canRevert(five, 0, [five, six])).toBe(false);
    // A requeued turn keeps its old checkpoint; a turn done after that checkpoint blocks it, whatever the ids.
    const a = one(1, done(0, { claimedAt: at(20), completedAt: at(21) }));
    const b = one(2, done(10));
    expect(canRevert(a, 0, [a, b])).toBe(false);
  });

  it('is blocked by another thread working on the scene', () => {
    const all = [one(1, done(0)), thread({ id: 2, status: 'working' }, [turn({ status: 'working', claimedAt: at(5), checkpointAt: at(5) })])];
    expect(canRevert(all[0], 0, all)).toBe(false);
  });

  it('finds the first turn that still counts, for reverting a whole thread', () => {
    const t = thread({ status: 'settled' }, [turn({ status: 'cancelled' }), done(1), done(3)]);
    expect(firstRevertableTurn(t, [t])).toBe(1);
    const blocked = [t, one(2, done(5))];
    expect(firstRevertableTurn(t, blocked)).toBeNull();
  });
});

describe('normalizeRequest', () => {
  it('reads a request written before threads as a one-turn thread for the external agent', () => {
    const legacy = {
      id: 3,
      createdAt: '2026-09-24T10:00:00.000Z',
      status: 'in_progress',
      selection,
      frame: 30,
      point: { x: 1, y: 2 },
      prompt: 'old ask',
      references: ['references/a.png'],
      attempt: 2,
      retryOf: 1,
      claimedAt: '2026-09-24T10:01:00.000Z',
      claimedBy: 'mcp-9',
      checkpoint: true,
      checkpointAt: '2026-09-24T10:01:00.000Z',
    };
    expect(normalizeRequest(legacy)).toEqual({
      id: 3,
      createdAt: legacy.createdAt,
      status: 'working',
      agent: 'external',
      sceneId: 'bear-test',
      turns: [
        {
          ask: { prompt: 'old ask', references: ['references/a.png'], selection, frame: 30, point: { x: 1, y: 2 }, at: legacy.createdAt },
          status: 'working',
          claimedAt: legacy.claimedAt,
          claimedBy: 'mcp-9',
          checkpointAt: legacy.checkpointAt,
          attempt: 2,
        },
      ],
    });
    const t = thread();
    expect(normalizeRequest(t)).toBe(t);
  });
});

describe('checkNewRequest', () => {
  const good = { selection: { sceneId: 'bear-test', layerId: 'pip', from: 0, to: 4 }, frame: 2, prompt: 'x', references: ['references/a.png'] };

  it('accepts a well-formed request, with an agent and settings', () => {
    expect(checkNewRequest(good)).toBeNull();
    expect(checkNewRequest({ ...good, point: { x: 1, y: 2 }, agent: 'claude', settings: { access: 'studio', model: 'opus', effort: 'high' } })).toBeNull();
  });

  it('names what is wrong with a malformed one', () => {
    expect(checkNewRequest(null)).toMatch(/object/);
    expect(checkNewRequest({ ...good, prompt: '' })).toMatch(/prompt/);
    expect(checkNewRequest({ ...good, frame: -1 })).toMatch(/frame/);
    expect(checkNewRequest({ ...good, selection: { sceneId: 's', from: 4, to: 4 } })).toMatch(/from.*to/);
    expect(checkNewRequest({ ...good, selection: { sceneId: '', from: 0, to: 4 } })).toMatch(/sceneId/);
    expect(checkNewRequest({ ...good, references: ['../../.ssh/id_rsa'] })).toMatch(/references\//);
    expect(checkNewRequest({ ...good, references: ['references/sub/a.png'] })).toMatch(/references\//);
    expect(checkNewRequest({ ...good, extra: 1 })).toMatch(/unknown field "extra"/);
    expect(checkNewRequest({ ...good, agent: 'gemini' })).toMatch(/agent must be one of/);
    expect(checkNewRequest({ ...good, settings: { access: 'root' } })).toMatch(/access/);
    expect(checkNewRequest({ ...good, settings: { access: 'studio', sandbox: 'off' } })).toMatch(/unknown settings field/);
  });

  it('takes no agent in a reply, since a thread keeps its agent', () => {
    expect(checkNewRequest(good, { reply: true })).toBeNull();
    expect(checkNewRequest({ ...good, agent: 'codex' }, { reply: true })).toMatch(/unknown field "agent"/);
  });
});
