// Mixing without ever letting three connections reach one input. Chromium
// sums three or more connections in hash-set order, which changes run to run,
// so output stops being identical (ticket 04). Two is safe.

/**
 * Sums `sources` into `dest` through a binary tree of unity GainNodes, so no
 * input, the destination's included, gets more than two connections. Sources
 * are paired in order, so the same list always builds the same tree.
 */
export function mix(ctx: BaseAudioContext, sources: readonly AudioNode[], dest: AudioNode): void {
  if (sources.length === 0) return;
  let level: AudioNode[] = [...sources];
  while (level.length > 2) {
    const next: AudioNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const sum = new GainNode(ctx, { gain: 1 });
      level[i].connect(sum);
      level[i + 1].connect(sum);
      next.push(sum);
    }
    level = next;
  }
  for (const node of level) node.connect(dest);
}
