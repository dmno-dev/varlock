import { execSyncVarlock, VarlockExecError } from './lib/exec-sync-varlock';

import { initVarlockEnv } from './runtime/env';
import { patchGlobalConsole } from './runtime/patch-console';
import { patchGlobalServerResponse } from './runtime/patch-server-response';
import { patchGlobalResponse } from './runtime/patch-response';

// The varlock loading process uses async calls, but we need this to run synchronously.
// because even with top level await, we run into hoisting issues where things happen out of order
// so we call out to the CLI using execSync
// this also isolates the varlock loading process from the end user process

try {
  const { stdout } = execSyncVarlock('load --format json-full --compact', {
    fullResult: true,
    // Pass the directory of this module so that in monorepos the binary search
    // starts from inside the varlock package (e.g. apps/web/node_modules/varlock)
    // rather than from process.cwd(), which may be an unrelated workspace root.
    callerDir: import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  });
  process.env.__VARLOCK_ENV = stdout;
} catch (err) {
  if (err instanceof VarlockExecError && err.stderr) {
    process.stderr.write(err.stderr);
  } else {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  process.exit((err as any).exitCode ?? 1);
}

// initialize varlock and patch globals as necessary
initVarlockEnv();
// these will be no-ops if these are disabled by settings
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();
