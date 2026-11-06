// A check (src/export/check.ts) as a job: the render worker measures the
// scene, and the report lands in .frame-studio/checks/, where an agent or a
// person can read it later. The MCP tool and the viewer both come through
// here. Node only.

import { join } from 'node:path';
import type { CheckReport } from '../../src/export/check.ts';
import { writeFileAtomic } from '../scene-files.ts';
import type { StudioFolder } from './folder.ts';
import type { RenderCallOptions, RenderPool } from './render-pool.ts';

/** Where a check's report goes. A film's scene id has a slash, so it gets a folder. */
export const checkFile = (folder: StudioFolder, scene: string): string => join(folder.studio, 'checks', `${scene}.json`);

export async function runCheck(
  host: { pool: RenderPool; folder: StudioFolder },
  scene: string,
  options: { from?: number; to?: number; loop?: boolean },
  call: RenderCallOptions = {},
): Promise<{ report: CheckReport; file: string }> {
  // A scene the worker doesn't know throws here, so `scene` is a real id by the time it names a file.
  const report = (await host.pool.call(scene, 'check', [options], call)) as CheckReport;
  const file = checkFile(host.folder, scene);
  await writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`);
  return { report, file };
}
