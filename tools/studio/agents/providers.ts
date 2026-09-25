// The agents the studio can run (ADR 0006). Each launches the user's own
// signed-in CLI. The scripted test agent joins them when
// FRAME_STUDIO_FAKE_AGENT=1. Node only.

import { claudeProvider } from './claude.ts';
import { codexProvider } from './codex.ts';
import { fakeProvider } from './fake.ts';
import type { AgentProvider } from './types.ts';

export function createProviders(studioDir: string): AgentProvider[] {
  const providers: AgentProvider[] = [claudeProvider(), codexProvider()];
  if (process.env.FRAME_STUDIO_FAKE_AGENT === '1') providers.push(fakeProvider(studioDir));
  return providers;
}
