// Prints how many techniques the library, loaded from this environment exactly as the battery loads it, took from the overlay folder.
// One line: `OVERLAY <n>`. Run by measure.ts in a measuring tree before a measurement is paid for.

import { loadEnv, processEnvironment } from '../env';
import { createLibrary } from '../library/registry';

const env = loadEnv({ ...processEnvironment(), NODE_ENV: undefined, BRAIN: 'claude-cli' });
const library = createLibrary(env.library);
process.stdout.write(`OVERLAY ${String(library.status().bySource.overlay)}\n`);
library.close();
