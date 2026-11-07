// Every generation provider the app knows (ADR 0017). Adding one is a pull
// request: a file in this folder and a line here.

import type { Provider } from '../types.ts';
import { elevenlabs } from './elevenlabs.ts';

export const providers: readonly Provider[] = [elevenlabs];
