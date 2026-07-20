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

/**
 * Build a plain `{ KEY: value }` map of the values that DID resolve, for the load-error hook.
 * On a validation failure (as opposed to a parse/schema error) the CLI still emits the fully
 * serialized graph to stdout, so items unrelated to the failure have real resolved values here
 * (e.g. a SENTRY_DSN needed to report the failure itself). Best-effort — returns `{}` if the
 * failure produced no parseable output.
 */
function getPartialResolvedEnv(err: unknown): Record<string, unknown> {
  const stdout = err instanceof VarlockExecError ? err.stdout : undefined;
  if (!stdout) return {};
  try {
    const parsed = JSON.parse(stdout);
    const env: Record<string, unknown> = {};
    for (const key in parsed?.config) env[key] = parsed.config[key]?.value;
    return env;
  } catch {
    return {};
  }
}

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
  const exitCode = (err as any).exitCode ?? 1;

  // By default we exit here (fail-fast). Apps can instead have auto-load THROW the error, so an
  // error tracker can report the load failure rather than the process dying silently. This is
  // opt-in, never inferred from the mere presence of some unrelated uncaughtException handler:
  //
  //  1. Set a `globalThis._varlockOnLoadError` hook — called with the error and the values that
  //     did resolve (e.g. a SENTRY_DSN needed to report the failure).
  //  2. Set `_VARLOCK_THROW_ON_LOAD_ERROR=1` — for when a tracker is already initialized with its
  //     own uncaughtException handler (e.g. Sentry via `--import`), so the throw lands there.
  //
  // Single-underscore prefixes (`_varlock*`, `_VARLOCK_*`) mark user-controllable behavior;
  // double-underscore `__varlock*` globals are set by varlock itself. The hook must be set BEFORE
  // this module is imported — ESM hoists all `import` statements, so register it via a side-effect
  // import ordered above `import 'varlock/auto-load'`, not an inline call.
  const onLoadError = (globalThis as any)._varlockOnLoadError;
  const hasHook = typeof onLoadError === 'function';
  const throwEnabled = hasHook || !!process.env._VARLOCK_THROW_ON_LOAD_ERROR;

  if (throwEnabled) {
    // We can't `await` here without making auto-load async, which would change env-injection
    // ordering (see note above about running synchronously). So reporting is best-effort:
    // give any async work a bounded window, then guarantee the process still exits.
    setTimeout(() => process.exit(exitCode), 2000).unref();

    if (hasHook) {
      // If nothing else would keep the event loop alive after we throw (no pre-registered
      // uncaughtException handler, e.g. Sentry's), add a no-op one so Node doesn't perform its
      // default immediate-exit and cut off the hook's async reporting. `once` keeps our global
      // footprint minimal: it only neutralizes the throw below.
      if (process.listenerCount('uncaughtException') === 0) {
        process.once('uncaughtException', () => {
          // no-op: keep the loop alive; the timer/hook-promise below drives the exit
        });
      }
      try {
        const result = onLoadError(err, getPartialResolvedEnv(err));
        // Exit as soon as the hook settles (observing the promise, not awaiting it).
        if (result && typeof result.then === 'function') {
          result.then(() => process.exit(exitCode), () => process.exit(exitCode));
        }
      } catch {
        // a broken hook must never mask the original load failure
      }
    }

    // Throw so downstream code never runs with invalid/missing env. A registered
    // uncaughtException handler (e.g. Sentry's) catches this and can flush; the timer bounds it.
    throw err;
  }

  // Default: preserve the original fail-fast behavior exactly.
  process.exit(exitCode);
}

// initialize varlock and patch globals as necessary
initVarlockEnv();
// these will be no-ops if these are disabled by settings
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();
