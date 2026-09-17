import { execSyncVarlock, VarlockExecError } from './lib/exec-sync-varlock';
import { encryptEnvBlobSync, generateEncryptionKeyHex, isEncryptedBlob } from './runtime/crypto';
import { evaluateInjectedEnvReuse, getPinnedBootKeys, type PinnedGraphInfo } from './lib/injected-env-reuse';
import { FrozenEnvFileError, USE_FROZEN_ENV_VAR } from './lib/frozen-env-file';
import { createDebug } from './lib/debug';
import { isVarlockCliChild } from './lib/cli-child-marker';

import { initVarlockEnv, getPreInjectionProcessEnv } from './runtime/env';
import { patchGlobalConsole } from './runtime/patch-console';
import { patchGlobalServerResponse } from './runtime/patch-server-response';
import { patchGlobalResponse } from './runtime/patch-response';

const debug = createDebug('varlock:auto-load');

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

function autoLoad() {
  // `@internal` keys stripped from a reused blob - their ambient env values are scrubbed
  // after init (see the bottom of this module)
  let strippedInternalKeys: Array<string> = [];
  // a pin that leaves `@dynamic=boot` keys to the runtime - the CLI applies it on top of the
  // schema, so failing to reach the CLI needs a more specific explanation than usual
  let pinnedForCli: PinnedGraphInfo | undefined;

  try {
    // A pre-resolved env graph can be consumed directly instead of re-resolving via the CLI:
    // either a `varlock freeze` file shipped inside the deploy artifact, or an already-injected
    // __VARLOCK_ENV blob (e.g. from a parent `varlock run`, or handed into a sandbox) - see
    // evaluateInjectedEnvReuse for the conditions. Throws when a frozen env file is present but
    // unusable, or in explicit-trust mode (_VARLOCK_USE_INJECTED_ENV=1) when the blob is
    // missing/unusable, which flows into the same load-failure handling below.
    const reuseDecision = evaluateInjectedEnvReuse({
      env: process.env,
      preInjectionEnv: getPreInjectionProcessEnv(),
      cwd: process.cwd(),
    });

    let parsed: any;
    let parsedJsonStr: string;
    if (reuseDecision.reuse) {
      debug('reusing pre-resolved env from %s - skipping resolution', reuseDecision.source);
      parsed = reuseDecision.parsedEnv;
      parsedJsonStr = reuseDecision.blobJson;
      strippedInternalKeys = reuseDecision.strippedInternalKeys;
    } else {
      debug('resolving env via CLI (%s)', reuseDecision.reason);
      pinnedForCli = reuseDecision.pinned;
      const { stdout } = execSyncVarlock('load --format json-full --compact', {
        fullResult: true,
        // Pass the directory of this module so that in monorepos the binary search
        // starts from inside the varlock package (e.g. apps/web/node_modules/varlock)
        // rather than from process.cwd(), which may be an unrelated workspace root.
        callerDir: import.meta.dirname ?? new URL('.', import.meta.url).pathname,
        // Spawn the CLI with the env as it was BEFORE the runtime auto-init re-injected the
        // parent blob's values into process.env (that injection happens during our own import
        // chain, when a plaintext blob is present). Otherwise a command-local override under a
        // parent `varlock run` (e.g. `varlock run -- sh -c 'FOO=x node app.js'`) reaches the
        // CLI already clobbered back to the parent's value, and the nested override handling
        // in load-graph can never see the user's real value.
        env: {
          ...getPreInjectionProcessEnv() as NodeJS.ProcessEnv,
          // `varlock load` only honors a frozen file when told to explicitly, so name the one
          // we found: pinned values stay sealed and only the boot keys are resolved live. A
          // frozen payload in __VARLOCK_ENV needs nothing extra - the trust flag is already set.
          ...(pinnedForCli?.source === 'frozen-file' ? { [USE_FROZEN_ENV_VAR]: pinnedForCli.filePath } : {}),
        },
      });
      parsed = JSON.parse(stdout);
      parsedJsonStr = stdout;
    }

    // set parsed object on globalThis so initVarlockEnv() picks it up directly
    (globalThis as any).__varlockLoadedEnv = parsed;

    // encrypt the blob in process.env so sensitive values aren't sitting
    // in plaintext in process.env.__VARLOCK_ENV
    // (a REUSED blob that arrived already encrypted stays exactly as-is - never write the
    // decrypted form back into process.env. after a fresh resolution the env blob is always
    // replaced, even if a stale encrypted parent blob was sitting there. a reused blob that
    // had @internal items stripped must also be re-written, so children never inherit them -
    // the ambient key is guaranteed present in that case, since decryption succeeded)
    const reusedEncryptedBlob = reuseDecision.reuse
      && reuseDecision.strippedInternalKeys.length === 0
      && !!process.env.__VARLOCK_ENV && isEncryptedBlob(process.env.__VARLOCK_ENV);
    if (!reusedEncryptedBlob) {
      let encryptionKey = process.env._VARLOCK_ENV_KEY;
      if (parsed.settings?.encryptInjectedEnv && !encryptionKey) {
        encryptionKey = generateEncryptionKeyHex();
        process.env._VARLOCK_ENV_KEY = encryptionKey;
      }
      if (encryptionKey) {
        process.env.__VARLOCK_ENV = encryptEnvBlobSync(parsedJsonStr, encryptionKey);
      } else {
        process.env.__VARLOCK_ENV = parsedJsonStr;
      }
    }
  } catch (err) {
    if (err instanceof VarlockExecError && err.stderr) {
      process.stderr.write(err.stderr);
    } else if (err instanceof FrozenEnvFileError) {
      // a setup/config problem, not a crash - a stack trace here is noise
      process.stderr.write(`${err.message}\n`);
    } else if (pinnedForCli && !(err instanceof VarlockExecError)) {
      // most likely the CLI is not in the runtime image (e.g. distroless) - a deliberate choice
      // for a fully pinned deploy, but boot keys need the schema at startup
      const bootKeys = getPinnedBootKeys(pinnedForCli.graph).join(', ');
      process.stderr.write(
        `[varlock] the frozen env leaves ${bootKeys} to boot (@dynamic=boot), which needs the varlock CLI and your .env.schema at startup: ${(err as Error).message}\n`
        + '[varlock] boot via `varlock run`, install the CLI alongside the app, or remove @dynamic=boot and re-freeze\n',
      );
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
  // An ambient value for an @internal key stripped from a reused blob must not stay readable
  // via process.env (matching `varlock run`'s ambient-carry stripping). This has to happen
  // AFTER initVarlockEnv, whose reload cleanup restores the pre-injection snapshot - and the
  // snapshot itself is scrubbed too, so a later re-init cannot bring the value back. Safe to
  // drop from the snapshot: its only legitimate consumer is a fresh resolution needing the
  // bootstrap secret, which by definition is not happening when a blob was reused.
  for (const internalKey of strippedInternalKeys) {
    delete process.env[internalKey];
    delete getPreInjectionProcessEnv()[internalKey];
  }
  // these will be no-ops if these are disabled by settings
  patchGlobalConsole();
  patchGlobalServerResponse();
  patchGlobalResponse();
}

// When this module is preloaded into the varlock CLI process that a parent auto-load (or
// integration) spawned to do the resolving - bun applies `bunfig.toml` `preload` to every
// script it runs, including a `varlock` CLI whose `node` shebang resolves to bun - resolving
// again here would spawn yet another CLI, which would be preloaded too, and so on: a fork bomb.
// Bail out entirely; the CLI itself does the work. See lib/cli-child-marker.ts.
if (isVarlockCliChild()) {
  debug('preloaded into a varlock CLI child process - skipping auto-load');
} else {
  autoLoad();
}
