import { describe, expect, it } from 'vitest';
import { canRevert, checkNewRequest, clipboardLine, describeTarget, displayStatus, requestFileName, STALL_MS, type StudioRequest } from './protocol';

function request(overrides: Partial<StudioRequest>): StudioRequest {
  return {
    id: 1,
    createdAt: '2026-09-24T15:00:00.000Z',
    status: 'pending',
    selection: { sceneId: 'bear-test', layerId: 'pip', from: 24, to: 48 },
    frame: 30,
    prompt: 'make pip sad here',
    references: [],
    ...overrides,
  };
}

describe('requestFileName', () => {
  it('pads ids to four digits and grows past them', () => {
    expect(requestFileName(7)).toBe('0007.json');
    expect(requestFileName(12345)).toBe('12345.json');
    expect(requestFileName(7, 'before')).toBe('0007.before.json');
    expect(requestFileName(7, 'claim')).toBe('0007.claim');
  });
});

describe('displayStatus', () => {
  const now = Date.parse('2026-09-24T15:30:00.000Z');
  it('shows a request in progress for longer than the stall time as stalled', () => {
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(displayStatus(request({ status: 'in_progress', claimedAt: at(STALL_MS + 1000) }), now)).toBe('stalled');
    expect(displayStatus(request({ status: 'in_progress', claimedAt: at(STALL_MS - 1000) }), now)).toBe('in_progress');
    expect(displayStatus(request({ status: 'done' }), now)).toBe('done');
  });
});

describe('clipboardLine', () => {
  it('says what to do in one line any agent can follow', () => {
    const line = clipboardLine(request({ id: 7 }));
    expect(line).toBe(
      'Frame Studio request #7: "make pip sad here" (bear-test, layer pip, frames [24, 48)). ' +
        'Read it with the frame-studio MCP tool get_request (id 7), then call complete_request when you are done.',
    );
    expect(line).not.toContain('\n');
  });

  it('describes a part, a whole-range selection, references and a retry', () => {
    const line = clipboardLine(
      request({ id: 9, selection: { sceneId: 's', from: 0, to: 4 }, prompt: 'redo\nthis', references: ['references/a.png'], attempt: 2, retryOf: 7 }),
    );
    expect(line).toContain('"redo this"');
    expect(line).toContain('(s, all layers, frames [0, 4), 1 reference image; attempt 2 of #7)');
    expect(clipboardLine(request({ selection: { sceneId: 's', layerId: 'pip', partId: 'mouth', from: 1, to: 2 } }))).toContain('layer pip › mouth');
  });
});

describe('canRevert', () => {
  const at = (minute: number) => `2026-09-24T15:${String(minute).padStart(2, '0')}:00.000Z`;
  /** A finished request on a scene, claimed at minute `claim` and done at `claim + 1`. */
  const done = (id: number, claim: number, extra: Partial<StudioRequest> = {}) =>
    request({
      id,
      status: 'done',
      checkpoint: true,
      checkpointAt: at(claim),
      claimedAt: at(claim),
      completedAt: at(claim + 1),
      selection: { sceneId: 'bear-test', from: 0, to: 4 },
      ...extra,
    });

  it('allows a finished request with a checkpoint when nothing else touched the scene after it', () => {
    const all = [done(1, 0), done(2, 5), done(3, 10, { selection: { sceneId: 'other', from: 0, to: 4 } })];
    expect(canRevert(all[1], all)).toBe(true);
    expect(canRevert(all[0], all)).toBe(false);
    expect(canRevert(all[2], all)).toBe(true);
    expect(canRevert(done(4, 0, { status: 'failed' }), [done(4, 0, { status: 'failed' })])).toBe(true);
  });

  it('ignores later requests that are pending, cancelled or already reverted, so undo steps back one at a time', () => {
    const all = [done(1, 0), done(2, 5, { status: 'reverted' }), request({ id: 3, status: 'pending' }), request({ id: 4, status: 'cancelled' })];
    expect(canRevert(all[0], all)).toBe(true);
  });

  it('refuses without a checkpoint, while pending or in progress, or once reverted', () => {
    expect(canRevert(done(1, 0, { checkpoint: false }), [])).toBe(false);
    expect(canRevert(done(1, 0, { status: 'in_progress' }), [])).toBe(false);
    expect(canRevert(done(1, 0, { status: 'reverted' }), [])).toBe(false);
  });

  it('goes by time, not id: a request claimed or finished after the checkpoint blocks it', () => {
    // Two sessions: #5 claimed first and finished last, #6 claimed and finished in between.
    const five = done(5, 0, { completedAt: at(9) });
    const six = done(6, 3, { completedAt: at(4) });
    expect(canRevert(six, [five, six])).toBe(false);
    expect(canRevert(five, [five, six])).toBe(false);
    // A requeued request keeps its old checkpoint; a request done after that checkpoint blocks it, whatever the ids.
    const one = done(1, 0, { claimedAt: at(20), completedAt: at(21) });
    const two = done(2, 10);
    expect(canRevert(one, [one, two])).toBe(false);
  });

  it('is blocked by another request on the scene that is still in progress', () => {
    const all = [done(1, 0), request({ id: 2, status: 'in_progress', claimedAt: at(5), checkpoint: true })];
    expect(canRevert(all[0], all)).toBe(false);
  });
});

describe('describeTarget', () => {
  it('names a layer, a part, or the whole range', () => {
    expect(describeTarget({ sceneId: 's', layerId: 'pip', from: 0, to: 1 })).toBe('layer pip');
    expect(describeTarget({ sceneId: 's', layerId: 'pip', partId: 'mouth', from: 0, to: 1 })).toBe('layer pip › mouth');
    expect(describeTarget({ sceneId: 's', from: 0, to: 1 })).toBe('all layers');
  });
});

describe('checkNewRequest', () => {
  const good = { selection: { sceneId: 'bear-test', layerId: 'pip', from: 0, to: 4 }, frame: 2, prompt: 'x', references: ['references/a.png'] };

  it('accepts a well-formed request', () => {
    expect(checkNewRequest(good)).toBeNull();
    expect(checkNewRequest({ ...good, point: { x: 1, y: 2 }, attempt: 2, retryOf: 1 })).toBeNull();
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
  });
});
