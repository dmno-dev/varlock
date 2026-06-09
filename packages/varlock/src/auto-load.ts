import { execSyncVarlock, VarlockExecError } from './lib/exec-sync-varlock';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from './runtime/crypto';

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

  const parsed = JSON.parse(stdout);
  // set parsed object on globalThis so initVarlockEnv() picks it up directly
  (globalThis as any).__varlockLoadedEnv = parsed;

  // encrypt the blob in process.env so sensitive values aren't sitting
  // in plaintext in process.env.__VARLOCK_ENV
  let encryptionKey = process.env._VARLOCK_ENV_KEY;
  if (parsed.settings?.encryptInjectedEnv && !encryptionKey) {
    encryptionKey = generateEncryptionKeyHex();
    process.env._VARLOCK_ENV_KEY = encryptionKey;
  }
  if (encryptionKey) {
    process.env.__VARLOCK_ENV = encryptEnvBlobSync(stdout, encryptionKey);
  } else {
    process.env.__VARLOCK_ENV = stdout;
  }
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
