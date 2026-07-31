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

  if (hasHook) {
    // Call the hook with the error and whatever values did resolve, then guarantee a non-zero
    // exit. We can't `await` here without making auto-load async (which would change env-injection
    // ordering — see note above about running synchronously), so we observe the returned promise
    // instead: exit as soon as it settles, bounded by a timer, and let it flush before then.
    let result: unknown;
    try {
      result = onLoadError(err, getPartialResolvedEnv(err));
    } catch {
      // a broken hook must never mask the original load failure
    }

    if (result && typeof (result as any).then === 'function') {
      // Async hook: keep the process alive until it settles (or a 2s bound), then exit non-zero.
      // Throw so downstream code never runs with invalid env; a no-op uncaughtException handler
      // (added only if nothing else would catch it) stops Node's immediate crash-exit so the
      // promise/timer below drives the exit code. The timer is intentionally NOT unref'd — it must
      // hold the loop open so the process can't drain and exit 0 before we report.
      setTimeout(() => process.exit(exitCode), 2000);
      (result as Promise<unknown>).then(() => process.exit(exitCode), () => process.exit(exitCode));
      if (process.listenerCount('uncaughtException') === 0) {
        process.once('uncaughtException', () => {
          // no-op: keep the loop alive; the promise/timer above drives the exit
        });
      }
      throw err;
    }

    // Sync hook: reporting is already done, so exit now. This also aborts downstream, and keeps
    // the exit code correct (a thrown error swallowed by a no-op handler would exit 0).
    process.exit(exitCode);
  }

  if (process.env._VARLOCK_THROW_ON_LOAD_ERROR) {
    // No hook, but a tracker is already initialized (e.g. Sentry via `--import`). Throw so its
    // uncaughtException handler captures the failure. Bound the flush and guarantee exit; if no
    // handler is actually registered, Node's default behavior exits non-zero anyway.
    setTimeout(() => process.exit(exitCode), 2000).unref();
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
