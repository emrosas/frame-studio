// Keyboard shortcuts. Pure mapping from a key event to a viewer action.

export type KeyAction =
  | { type: 'toggle' }
  | { type: 'step'; delta: number }
  | { type: 'seek'; to: 'start' | 'end' }
  /** I: the range's in point goes to the frame on screen. */
  | { type: 'markIn' }
  /** O: the range's out point goes to the frame on screen (included). */
  | { type: 'markOut' }
  /** Escape: clears the hover, else the layer selection, else the range. */
  | { type: 'escape' }
  /** M: sound on or off. */
  | { type: 'mute' }
  /** X: the range goes to the span of what is selected. */
  | { type: 'markSpan' }
  /** Return: the prompt takes the keyboard. */
  | { type: 'compose' }
  /** Command-Z and Shift-Command-Z: clip edits on the timeline. */
  | { type: 'undo' }
  | { type: 'redo' }
  /** A key the viewer owns but should not act on (Space auto-repeat). */
  | { type: 'ignore' };

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** True for auto-repeat while the key is held. */
  repeat?: boolean;
}

/**
 * Space play/pause, Left/Right one frame (Shift: one second), Home/End,
 * I and O for the range, X for the span of what is selected, Escape to clear
 * the selection one step at a time, M for sound on or off, Return to go to the
 * prompt, and Command-Z with Shift to undo and redo a clip edit.
 * A held Space or M toggles once: its auto-repeats are ignored. Held arrows keep
 * stepping, so they scrub.
 */
export function keyAction(e: KeyInput, fps: number): KeyAction | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) return { type: e.shiftKey ? 'redo' : 'undo' };
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const big = Math.max(1, Math.round(fps));
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      return e.repeat ? { type: 'ignore' } : { type: 'toggle' };
    case 'ArrowLeft':
      return { type: 'step', delta: e.shiftKey ? -big : -1 };
    case 'ArrowRight':
      return { type: 'step', delta: e.shiftKey ? big : 1 };
    case 'Home':
      return { type: 'seek', to: 'start' };
    case 'End':
      return { type: 'seek', to: 'end' };
    case 'i':
    case 'I':
      return { type: 'markIn' };
    case 'o':
    case 'O':
      return { type: 'markOut' };
    case 'x':
    case 'X':
      return { type: 'markSpan' };
    case 'Enter':
      return e.shiftKey ? null : { type: 'compose' };
    case 'Escape':
      return { type: 'escape' };
    case 'm':
    case 'M':
      return e.repeat ? { type: 'ignore' } : { type: 'mute' };
    default:
      return null;
  }
}

/**
 * Whether the focused element should keep a key for itself. Text fields and
 * selects keep everything; a focused button keeps Space (it clicks natively).
 * The scrubber (range input) hands its keys to the viewer so Shift works.
 */
export function focusKeepsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return (target as HTMLInputElement).type !== 'range';
  if (tag === 'BUTTON') return key === ' ' || key === 'Enter';
  return false;
}
