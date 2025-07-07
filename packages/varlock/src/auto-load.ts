import { execSync } from 'node:child_process';

import { initVarlockEnv } from './runtime/env';
import { patchGlobalConsole } from './runtime/patch-console';
import { patchGlobalServerResponse } from './runtime/patch-server-response';
import { patchGlobalResponse } from './runtime/patch-response';

// The varlock loading process uses async calls, but we need this to run synchronously.
// because even with top level await, we run into hoisting issues where things happen out of order
// so we call out to the CLI using execSync
// this also isolates the varlock loading process from the end user process
const execResult = execSync('varlock load --format json-full');
process.env.__VARLOCK_ENV = execResult.toString();

// initialize varlock and patch globals as necessary
initVarlockEnv();
// these will be no-ops if these are disabled by settings
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();

