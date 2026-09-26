// Frame Studio render tools (the commands are in commands.ts).
//
//   npm run render -- --scene bear-test --frame 47
//   npm run export -- --scene bear-test --target mp4
//   npm run export -- --scene bear-test --target html
//   npm run contact-sheet -- --scene bear-test --every 6
//
// The studio's TypeScript imports without extensions, so the loader goes in
// before anything under src/ does (tools/studio/loader.ts).

import { join } from 'node:path';
import { REPO } from '../studio/folder.ts';
import { installLoader } from '../studio/loader.ts';

installLoader(join(REPO, 'src'));
await import('./commands.ts');
