// What an agent reads about a thread (ADR 0006): the turns so far, then the
// ask it works on now. The external agent gets it from the MCP request tools;
// the agents inside the studio get it as their turn's prompt. Pure, apart from
// what the caller looks up about the scene. Node only; runs as TypeScript
// through type stripping.

import { currentTurn, describeTarget, type RequestSelection, type StudioRequest, type Turn } from '../../src/studio/protocol.ts';

/** What the caller knows about the thread's scene. */
export interface SceneInfo {
  /** Repo-relative, e.g. "scenes/bear-test.json". */
  file?: string;
  /** Frame to MM:SS:FF, when the scene is valid. */
  timecode?: (frame: number) => string;
}

export interface DescribeOptions {
  /** external: an MCP agent, which must call complete_request. studio: an agent the studio runs, whose turn ends when it stops. */
  agent: 'external' | 'studio';
  /** Leave out earlier turns, when the agent's own session already holds them. */
  history?: boolean;
}

function range(s: RequestSelection, info: SceneInfo): string {
  const tc = info.timecode ? ` (${info.timecode(s.from)} to ${info.timecode(s.to)})` : '';
  return `frames [${s.from}, ${s.to})${tc}`;
}

function target(s: RequestSelection): string {
  return `${describeTarget(s)}${s.layerId === undefined ? ' (a whole-frame-range selection)' : ''}`;
}

const OUTCOME: Record<Turn['status'], string> = {
  pending: 'waiting',
  working: 'in progress',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped by the user',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
  reverted: 'reverted by the user; its changes were undone',
};

/** The thread for an agent: history, then the current ask and how to work it. */
export function describeThread(request: StudioRequest, info: SceneInfo, options: DescribeOptions): string {
  const turn = currentTurn(request);
  const k = request.turns.length - 1;
  const s = turn.ask.selection;
  const lines: string[] = [];
  lines.push(
    `Frame Studio request #${request.id}, a thread on scene ${request.sceneId}${info.file ? ` (${info.file})` : ''}. Status: ${request.status.replace('_', ' ')}.`,
  );
  const earlier = request.turns.slice(0, k);
  if (options.history !== false && earlier.length > 0) {
    lines.push('', 'Earlier in this thread:');
    earlier.forEach((t, i) => {
      lines.push(`${i + 1}. The user asked: ${t.ask.prompt}`);
      lines.push(`   Selection: ${target(t.ask.selection)}, ${range(t.ask.selection, info)}.`);
      lines.push(`   Outcome: ${OUTCOME[t.status]}${t.summary ? `. Summary: ${t.summary}` : ''}`);
    });
  }
  const attempt = turn.attempt && turn.attempt > 1 ? ` (attempt ${turn.attempt}: the user reverted the last try and asked again)` : '';
  lines.push(
    '',
    earlier.length > 0 ? `Now, turn ${k + 1}${attempt}:` : `The ask${attempt}:`,
    `Prompt: ${turn.ask.prompt}`,
    `Selection: ${target(s)}, ${range(s, info)}`,
    `Frame on screen when sent: ${turn.ask.frame}${turn.ask.point ? `; the user clicked scene pixel (${Math.round(turn.ask.point.x)}, ${Math.round(turn.ask.point.y)})` : ''}`,
  );
  if (turn.ask.references.length > 0) {
    lines.push(`Reference images (open them to see what the user means; never put them in a scene or export): ${turn.ask.references.join(', ')}`);
  }
  if (turn.checkpointAt) lines.push('The scene was saved before this turn, so the user can revert it.');
  lines.push(
    '',
    'How to do it: look with render_frame, render_contact_sheet and hit_test. Change it with apply_to_selection (pass this selection), update_scene, or a new rig variant under src/rigs applied through an override. Render again to check.',
  );
  if (options.agent === 'external') {
    lines.push(
      `When you finish this turn, call complete_request with id ${request.id}, status "done" or "failed", and a one-line summary of what you changed or why it failed. The user may reply; a reply comes back as the next turn of this request.`,
    );
  } else {
    lines.push(
      'When you finish, end with one line that sums up what you changed, or why you could not. The user will see it and may reply.',
    );
  }
  return lines.join('\n');
}
