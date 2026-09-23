import { describe, expect, it } from 'vitest';
import { DEFAULT_PROPS, createRecordingContext, splitLayerLogs } from './recording-context';

describe('recording context', () => {
  it('logs method calls and property sets in order', () => {
    const rec = createRecordingContext();
    rec.ctx.fillStyle = '#ff0000';
    rec.ctx.moveTo(1, 2);
    rec.ctx.lineWidth = 3;
    expect(rec.log.map((e) => (e.op === 'set' ? `set ${e.name}=${String(e.value)}` : `call ${e.name}`))).toEqual([
      'set fillStyle=#ff0000',
      'call moveTo',
      'set lineWidth=3',
    ]);
  });

  it('starts from canvas default state and reads back what was set', () => {
    const rec = createRecordingContext(640, 360);
    expect(rec.state().props).toEqual(DEFAULT_PROPS);
    expect(rec.ctx.canvas.width).toBe(640);
    rec.ctx.globalAlpha = 0.5;
    expect(rec.ctx.globalAlpha).toBe(0.5);
    expect('fillRect' in rec.ctx).toBe(true);
    expect('notAMethod' in rec.ctx).toBe(false);
  });

  it('save/restore restores props, transform, dash, and clips but not the path', () => {
    const rec = createRecordingContext();
    const { ctx } = rec;
    ctx.save();
    ctx.fillStyle = 'red';
    ctx.translate(10, 20);
    ctx.setLineDash([2, 3]);
    ctx.rect(0, 0, 5, 5);
    ctx.clip();
    expect(rec.saveDepth()).toBe(1);
    ctx.restore();
    expect(rec.saveDepth()).toBe(0);
    const s = rec.state();
    expect(s.props.fillStyle).toBe('#000000');
    expect(s.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(s.lineDash).toEqual([]);
    expect(s.clips).toEqual([]);
    ctx.fill();
    const last = rec.log[rec.log.length - 1];
    expect(last.op === 'call' && last.paint?.path?.map((p) => p.name)).toEqual(['rect']);
  });

  it('tracks transforms', () => {
    const rec = createRecordingContext();
    const { ctx } = rec;
    ctx.translate(10, 0);
    ctx.scale(2, 3);
    ctx.rotate(Math.PI / 2);
    const [a, b, c, d, e, f] = rec.state().transform;
    expect(a).toBeCloseTo(0);
    expect(b).toBeCloseTo(3);
    expect(c).toBeCloseTo(-2);
    expect(d).toBeCloseTo(0);
    expect(e).toBe(10);
    expect(f).toBe(0);
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    expect(rec.state().transform).toEqual([2, 0, 0, 2, 0, 0]);
    ctx.translate(Number.NaN, 1); // ignored, like a real canvas
    expect(rec.state().transform).toEqual([2, 0, 0, 2, 0, 0]);
    ctx.resetTransform();
    expect(rec.state().transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('paint calls carry the state that affects them', () => {
    const rec = createRecordingContext();
    rec.ctx.fillStyle = 'blue';
    rec.ctx.fillRect(0, 0, 1, 1);
    rec.ctx.clearRect(0, 0, 1, 1);
    const [, fillRect, clearRect] = rec.log;
    expect(fillRect.op === 'call' && fillRect.paint?.props?.fillStyle).toBe('blue');
    expect(clearRect.op === 'call' && clearRect.paint?.props).toBeUndefined();
  });

  it('gradients are logged as comparable descriptions', () => {
    const mk = () => {
      const rec = createRecordingContext();
      const g = rec.ctx.createLinearGradient(0, 0, 10, 0);
      g.addColorStop(0, 'red');
      g.addColorStop(1, 'blue');
      rec.ctx.fillStyle = g;
      return rec;
    };
    const a = mk();
    expect(a.ctx.fillStyle).toEqual({ kind: 'linearGradient', args: [0, 0, 10, 0], stops: [[0, 'red'], [1, 'blue']] });
    expect(a.log).toEqual(mk().log);
  });

  it('splitLayerLogs returns the entries inside each depth-2 save/restore', () => {
    const rec = createRecordingContext();
    const { ctx } = rec;
    ctx.save();
    ctx.clearRect(0, 0, 1, 1);
    ctx.save();
    ctx.fillRect(0, 0, 1, 1);
    ctx.save();
    ctx.restore();
    ctx.restore();
    ctx.save();
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    const chunks = splitLayerLogs(rec.log);
    expect(chunks.map((c) => c.map((e) => (e.op === 'call' ? e.name : e.name)))).toEqual([
      ['fillRect', 'save', 'restore'],
      ['stroke'],
    ]);
  });
});
