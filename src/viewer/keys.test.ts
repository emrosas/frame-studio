import { describe, expect, it } from 'vitest';
import { keyAction } from './keys';

const press = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe('keyAction', () => {
  it('takes Delete and Backspace for the selected key', () => {
    expect(keyAction(press('Delete'), 12)).toEqual({ type: 'delete' });
    expect(keyAction(press('Backspace'), 12)).toEqual({ type: 'delete' });
  });

  it('maps the shortcuts', () => {
    expect(keyAction(press(' '), 12)).toEqual({ type: 'toggle' });
    expect(keyAction(press('ArrowLeft'), 12)).toEqual({ type: 'step', delta: -1 });
    expect(keyAction(press('ArrowRight'), 12)).toEqual({ type: 'step', delta: 1 });
    expect(keyAction(press('Home'), 12)).toEqual({ type: 'seek', to: 'start' });
    expect(keyAction(press('End'), 12)).toEqual({ type: 'seek', to: 'end' });
  });

  it('Shift steps one second of frames', () => {
    expect(keyAction(press('ArrowRight', { shiftKey: true }), 24)).toEqual({ type: 'step', delta: 24 });
    expect(keyAction(press('ArrowLeft', { shiftKey: true }), 12)).toEqual({ type: 'step', delta: -12 });
  });

  it('swallows auto-repeat of Space so holding it does not flip play and pause', () => {
    expect(keyAction(press(' ', { repeat: true }), 12)).toEqual({ type: 'ignore' });
  });

  it('keeps auto-repeat for stepping so a held arrow scrubs', () => {
    expect(keyAction(press('ArrowRight', { repeat: true }), 12)).toEqual({ type: 'step', delta: 1 });
    expect(keyAction(press('ArrowLeft', { repeat: true, shiftKey: true }), 12)).toEqual({ type: 'step', delta: -12 });
  });

  it('I and O set the in and out points, with or without Shift (caps)', () => {
    expect(keyAction(press('i'), 12)).toEqual({ type: 'markIn' });
    expect(keyAction(press('I', { shiftKey: true }), 12)).toEqual({ type: 'markIn' });
    expect(keyAction(press('o'), 12)).toEqual({ type: 'markOut' });
    expect(keyAction(press('O'), 12)).toEqual({ type: 'markOut' });
    expect(keyAction(press('i', { metaKey: true }), 12)).toBeNull();
    expect(keyAction(press('o', { altKey: true }), 12)).toBeNull();
  });

  it('M turns sound on or off, and leaves Cmd+M to the system', () => {
    expect(keyAction(press('m'), 12)).toEqual({ type: 'mute' });
    expect(keyAction(press('M'), 12)).toEqual({ type: 'mute' });
    expect(keyAction(press('m', { metaKey: true }), 12)).toBeNull();
    expect(keyAction(press('m', { repeat: true }), 12)).toEqual({ type: 'ignore' });
  });

  it('Escape clears one step of the selection', () => {
    expect(keyAction(press('Escape'), 12)).toEqual({ type: 'escape' });
    expect(keyAction(press('Escape', { ctrlKey: true }), 12)).toBeNull();
  });

  it('maps the selection keys', () => {
    expect(keyAction(press('x'), 12)).toEqual({ type: 'markSpan' });
    expect(keyAction(press('Enter'), 12)).toEqual({ type: 'compose' });
    expect(keyAction(press('Enter', { shiftKey: true }), 12)).toBeNull();
  });

  it('maps undo and redo, on Command and on Control', () => {
    expect(keyAction(press('z', { metaKey: true }), 12)).toEqual({ type: 'undo' });
    expect(keyAction(press('z', { ctrlKey: true }), 12)).toEqual({ type: 'undo' });
    expect(keyAction(press('z', { metaKey: true, shiftKey: true }), 12)).toEqual({ type: 'redo' });
    expect(keyAction(press('z'), 12)).toBeNull();
  });

  it('leaves modified and unknown keys alone', () => {
    expect(keyAction(press('ArrowLeft', { metaKey: true }), 12)).toBeNull();
    expect(keyAction(press('r', { ctrlKey: true }), 12)).toBeNull();
    expect(keyAction(press('a'), 12)).toBeNull();
  });
});


describe('timeline edits', () => {
  it('takes S for split and Command-D for duplicate', () => {
    expect(keyAction(press('s'), 12)).toEqual({ type: 'split' });
    expect(keyAction(press('S'), 12)).toEqual({ type: 'split' });
    expect(keyAction(press('d', { metaKey: true }), 12)).toEqual({ type: 'duplicate' });
    expect(keyAction(press('d', { ctrlKey: true }), 12)).toEqual({ type: 'duplicate' });
  });

  it('leaves Command-S, Shift-Command-D and a plain D alone', () => {
    expect(keyAction(press('s', { metaKey: true }), 12)).toBeNull();
    expect(keyAction(press('d', { metaKey: true, shiftKey: true }), 12)).toBeNull();
    expect(keyAction(press('d'), 12)).toBeNull();
  });
});
