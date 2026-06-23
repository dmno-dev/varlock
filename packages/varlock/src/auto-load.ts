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

  // The `load` CLI read the .env files; any `_VARLOCK_*` config vars it found there (e.g.
  // _VARLOCK_ENV_KEY in .env.local) come back on this side-channel field, not as real config.
  // Strip it out so it never leaks into the injected blob, then re-serialize for the blob
  // (only when present, so the common path is unchanged).
  const fileConfigVars = parsed.__varlockConfigVars as Record<string, string> | undefined;
  let blobJson = stdout;
  if (fileConfigVars) {
    delete parsed.__varlockConfigVars;
    blobJson = JSON.stringify(parsed);
  }

  // set parsed object on globalThis so initVarlockEnv() picks it up directly
  (globalThis as any).__varlockLoadedEnv = parsed;

  // encrypt the blob in process.env so sensitive values aren't sitting in plaintext in
  // process.env.__VARLOCK_ENV. A real _VARLOCK_ENV_KEY wins over one set in a .env file.
  let encryptionKey = process.env._VARLOCK_ENV_KEY ?? fileConfigVars?._VARLOCK_ENV_KEY;
  if (parsed.settings?.encryptInjectedEnv && !encryptionKey) {
    encryptionKey = generateEncryptionKeyHex();
  }
  if (encryptionKey) {
    // ensure the key is in process.env so spawned children / runtime init can decrypt the blob
    process.env._VARLOCK_ENV_KEY ||= encryptionKey;
    process.env.__VARLOCK_ENV = encryptEnvBlobSync(blobJson, encryptionKey);
  } else {
    process.env.__VARLOCK_ENV = blobJson;
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
