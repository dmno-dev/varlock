import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { createChildSignalForwarder } from '../../lib/child-signals';
import { isVarlockReservedKey } from '../../env-graph/lib/reserved-vars';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { getCliItemFilter } from '../helpers/item-filter';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { resolveStdoutRedaction, pipeRedactedStreams } from '../helpers/stdout-redaction';
import { flushSchemaLoadedEvent } from '../helpers/telemetry';
import { buildInjectedBlobEnv } from '../helpers/injected-env-blob';
import { resolveInjectMode } from '../helpers/inject-mode';
import { CliExitError } from '../helpers/exit-error';
import { evaluateInjectedEnvReuse, getUseInjectedEnvMode, USE_INJECTED_ENV_VAR } from '../../lib/injected-env-reuse';
import { FrozenEnvFileError, getFrozenEnvFileInPlay, USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import { injectedEnvStringForm } from '../../lib/injected-env-provenance';
import { isEncryptedBlob, encryptEnvBlobSync } from '../../runtime/crypto';
import { getPreInjectionProcessEnv } from '../../runtime/env';
import { createDebug } from '../../lib/debug';
import { commandSpec } from './run.command-spec';
import type { EnvGraph, SerializedEnvGraph } from '../../env-graph';

const debug = createDebug('varlock:run');

export { commandSpec };

let commandProcess: ReturnType<typeof exec> | undefined;
let childCommandKilledFromRestart = false;

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // if "--" is present, split the args into our command and the rest, which will be another external command
  const argv = process.argv.slice(2);
  let restCommandArgs: Array<string> = [];
  if (argv.includes('--')) {
    const doubleDashIndex = argv.indexOf('--');
    restCommandArgs = argv.slice(doubleDashIndex + 1);
  } else {
    throw new Error('No command to run! Your command should look like `varlock run -- <your-command>`');
  }
  const commandToRunAsArgs = restCommandArgs;
  const commandToRunStr = restCommandArgs.join(' ');

  const rawCommand = commandToRunAsArgs[0];
  const commandArgsOnly = commandToRunAsArgs.slice(1);

  // const isWatchEnabled = ctx.values.watch;
  const isWatchEnabled = false;

  // console.log('running command', pathAwareCommand || rawCommand, commandArgsOnly);


  // An already-injected __VARLOCK_ENV blob (from a parent `varlock run`, or handed into a
  // sandbox with no .env files alongside _VARLOCK_USE_INJECTED_ENV=1) can be consumed
  // directly instead of re-resolving - same conditions and escape hatches as
  // varlock/auto-load. Flags that change what a fresh resolution would produce disable
  // reuse (and are rejected when reuse was explicitly forced, rather than being silently
  // ignored).
  const resolutionFlags = [
    ctx.values.path?.length ? '--path' : undefined,
    ctx.values.filter ? '--filter' : undefined,
    ctx.values['clear-cache'] ? '--clear-cache' : undefined,
    ctx.values['skip-cache'] ? '--skip-cache' : undefined,
    ctx.values['include-internal'] ? '--include-internal' : undefined,
  ].filter(Boolean) as Array<string>;

  let reuseDecision: ReturnType<typeof evaluateInjectedEnvReuse>;
  if (resolutionFlags.length) {
    // A frozen env file is a deploy-time pin, so silently ignoring it and re-resolving would
    // defeat the point just as much as it would for an explicitly-forced blob.
    const frozenFilePath = getFrozenEnvFileInPlay(process.env, process.cwd());
    if (frozenFilePath) {
      throw new CliExitError(`a frozen env file (${frozenFilePath}) cannot be combined with ${resolutionFlags.join(', ')}`, {
        suggestion: 'These flags change what a fresh resolution produces, so there is nothing to reuse. Drop them, '
          + `re-run \`varlock freeze\` with them, or set ${USE_FROZEN_ENV_VAR}=0 to resolve from .env files.`,
      });
    }
    if (getUseInjectedEnvMode(process.env) === 'force') {
      throw new CliExitError(`${USE_INJECTED_ENV_VAR} cannot be combined with ${resolutionFlags.join(', ')}`, {
        suggestion: 'These flags change what a fresh resolution produces, so there is nothing to reuse. Drop them, or unset the env var to resolve normally.',
      });
    }
    reuseDecision = { reuse: false, reason: `resolution flags passed (${resolutionFlags.join(', ')})` };
  } else {
    try {
      reuseDecision = evaluateInjectedEnvReuse({
        env: process.env,
        preInjectionEnv: getPreInjectionProcessEnv(),
        cwd: process.cwd(),
      });
    } catch (err) {
      // a frozen env file that is present but unusable, or explicit trust mode with a
      // missing/unusable blob - neither ever falls back to a fresh resolution
      if (err instanceof FrozenEnvFileError) {
        throw new CliExitError((err as Error).message.replace(/^\[varlock\] /, ''), {
          suggestion: 'Re-create it with `varlock freeze`, make sure _VARLOCK_ENV_KEY matches the key it was frozen with, '
            + `or set ${USE_FROZEN_ENV_VAR}=0 to resolve from .env files instead.`,
        });
      }
      throw new CliExitError((err as Error).message.replace(/^\[varlock\] /, ''), {
        suggestion: 'Provide a valid __VARLOCK_ENV blob (e.g. captured via `varlock load --format json-full --compact`), '
          + `or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files.`,
      });
    }
  }

  // by default @internal items are never handed to the child; --include-internal opts out
  // (e.g. a nested `varlock run` whose own resolution needs a secret-zero token)
  const includeInternal = !!ctx.values['include-internal'];

  let envGraph: EnvGraph | undefined;
  let filterKeys: Set<string> | undefined;
  let resolvedEnv: Record<string, string | undefined>;
  let serializedGraph: SerializedEnvGraph;

  if (reuseDecision.reuse) {
    debug('reusing pre-resolved env from %s - skipping resolution', reuseDecision.source);
    serializedGraph = reuseDecision.parsedEnv;
    // same shape as getResolvedEnvStringObject: unset items stay undefined, so they still
    // mask any inherited value when the child env is built. The blob never carries
    // @internal items, so there is nothing extra to strip.
    resolvedEnv = {};
    for (const [itemKey, item] of Object.entries(serializedGraph.config)) {
      resolvedEnv[itemKey] = injectedEnvStringForm(item);
    }
  } else {
    debug('resolving env (%s)', reuseDecision.reason);
    // A pin that leaves `@dynamic=boot` keys to the runtime is applied on top of the schema:
    // pinned values stay sealed (their resolvers never run) and only the boot keys are
    // resolved and validated here. The child then gets a complete, fresh blob.
    envGraph = await loadVarlockEnvGraph({
      entryFilePaths: ctx.values.path,
      clearCache: ctx.values['clear-cache'],
      skipCache: ctx.values['skip-cache'],
      pinned: reuseDecision.pinned,
    });
    checkForSchemaErrors(envGraph);
    checkForNoEnvFiles(envGraph);

    // Generate types before resolving values — uses only non-env-specific schema info
    await envGraph.runCodeGeneratorsIfNeeded();

    // A --filter scopes resolution (and validation) to what it selects plus dependencies — an
    // unrelated broken item outside the filter won't block this run, and excluded items'
    // value resolvers never run. Decorator selectors resolve item metadata first, then match
    // exactly (see EnvGraph.resolveEnvValuesForFilter).
    const itemFilter = getCliItemFilter(ctx.values.filter);
    if (itemFilter) await itemFilter.resolveScoped(envGraph);
    else await envGraph.resolveEnvValues();
    checkForConfigErrors(envGraph);

    // will fail above if there are any errors

    filterKeys = itemFilter?.getFilterKeys(Object.values(envGraph.configSchema));
    // string-serialized values (composites become separator-joined/JSON strings) since
    // these are injected directly into the child's process.env
    resolvedEnv = envGraph.getResolvedEnvStringObject({ includeInternal, filterKeys });
    serializedGraph = envGraph.getSerializedGraph({ filterKeys });
  }

  // `@injectUndefinedAsEmpty` opts into dotenv-style behavior: unset items become empty strings
  // in the child env instead of being dropped (either way they mask any inherited value)
  if (serializedGraph.settings?.injectUndefinedAsEmpty) {
    for (const itemKey in resolvedEnv) {
      if (resolvedEnv[itemKey] === undefined) resolvedEnv[itemKey] = '';
    }
  }

  const { resetRedactionMap } = await import('../../runtime/env');
  // console.log(resolvedEnv);

  // handle deprecated --no-inject-graph flag
  let injectDefault = 'all';
  if (ctx.values['no-inject-graph']) {
    console.warn('[varlock] ⚠️  --no-inject-graph is deprecated, use --inject vars instead');
    injectDefault = 'vars';
  }
  const { injectVars, injectBlob } = resolveInjectMode(ctx.values.inject, injectDefault as 'all' | 'vars');

  // when reusing, the ambient blob passes through untouched (it may be encrypted - the
  // ambient key rides along with it); a fresh resolution builds a new blob, honoring
  // @encryptInjectedEnv in blob-only mode and reusing/forwarding an ambient key
  let injectedBlobEnv: { __VARLOCK_ENV?: string, _VARLOCK_ENV_KEY?: string } = {};
  if (!reuseDecision.reuse) {
    injectedBlobEnv = buildInjectedBlobEnv({
      serializedGraph,
      injectVars,
      injectBlob,
      ambientEnvKey: process.env._VARLOCK_ENV_KEY,
    });
  } else if (injectBlob) {
    let childBlob: string;
    if (reuseDecision.source === 'frozen-file') {
      // the graph came from disk, so there is no ambient blob to forward (and any that is
      // present lost to the file, so it must not leak through): hand the child the frozen
      // graph itself, encrypted whenever a key is available - it always is when the file
      // was encrypted, since decryption succeeded
      const ambientKey = process.env._VARLOCK_ENV_KEY;
      childBlob = ambientKey ? encryptEnvBlobSync(reuseDecision.blobJson, ambientKey) : reuseDecision.blobJson;
    } else {
      // normally the ambient blob is forwarded byte-for-byte; if @internal items were
      // stripped from it on consumption, forward the sanitized form instead (re-encrypted
      // with the ambient key when the original was encrypted - the key must have been
      // present for decryption to have succeeded)
      childBlob = process.env.__VARLOCK_ENV!;
      if (reuseDecision.strippedInternalKeys.length) {
        childBlob = isEncryptedBlob(childBlob)
          ? encryptEnvBlobSync(reuseDecision.blobJson, process.env._VARLOCK_ENV_KEY!)
          : reuseDecision.blobJson;
      }
    }
    injectedBlobEnv = {
      __VARLOCK_ENV: childBlob,
      ...(process.env._VARLOCK_ENV_KEY ? { _VARLOCK_ENV_KEY: process.env._VARLOCK_ENV_KEY } : {}),
    };
  }

  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(injectVars ? resolvedEnv : {}),
    __VARLOCK_RUN: '1', // flag for a child process to detect it is running via `varlock run`
    ...injectedBlobEnv,
  };

  // @internal items must not reach the application. The spread of process.env above can carry
  // an ambiently-set value (e.g. `OP_TOKEN=xxx varlock run ...`), so strip those keys here —
  // unless --include-internal was passed, in which case they were intentionally injected above.
  // (reuse path: internal items were already stripped from the blob itself on consumption,
  // and --include-internal disables reuse - but the same ambient-carry hole applies)
  if (envGraph && !includeInternal) {
    for (const itemKey of envGraph.sortedConfigKeys) {
      if (envGraph.configSchema[itemKey].isInternal) delete fullInjectedEnv[itemKey];
    }
  } else if (reuseDecision.reuse) {
    for (const itemKey of reuseDecision.strippedInternalKeys) delete fullInjectedEnv[itemKey];
  }

  // Same ambient-carry problem for --filter: an excluded schema key set in the calling env
  // (e.g. `STRIPE_DEBUG_KEY=x varlock run --filter='!STRIPE_DEBUG_KEY' ...`) would otherwise pass
  // straight through the process.env spread — and since excluded items are also left out of the
  // redaction map, it would even print unredacted. Reserved _VARLOCK_* keys configure varlock's
  // own behavior (incl. in nested runs) and are never subject to --filter.
  if (envGraph && filterKeys) {
    for (const itemKey of envGraph.sortedConfigKeys) {
      if (isVarlockReservedKey(itemKey)) continue;
      if (!filterKeys.has(itemKey)) delete fullInjectedEnv[itemKey];
    }
  }

  // (the encryption key for blob-only injection is handled by buildInjectedBlobEnv above,
  // which also honors @encryptInjectedEnv)

  // Per-stream TTY auto-detect (interactive terminal -> raw inherit; piped/redirected ->
  // redact). Shared with `varlock proxy run` so the two commands can't diverge.
  const { redactStdout, redactStderr } = resolveStdoutRedaction({
    redactStdoutFlag: ctx.values['redact-stdout'],
    redactLogs: serializedGraph.settings?.redactLogs ?? true,
  });

  // The schema is resolved and validated by now, and nothing in this process changes it
  // afterwards, so send the schema usage event here rather than at exit. A long-running
  // child (a server) may only ever end by SIGKILL, in which case an exit-time flush is
  // lost. Fire-and-forget: the request completes while the child runs, gracefulExit still
  // awaits anything pending, and taking the payload makes the exit-time flush a no-op.
  flushSchemaLoadedEvent().catch(() => undefined);

  // Forward terminating signals to the child and wait for it, rather than exiting and
  // losing both the graceful shutdown and the true exit code (see createChildSignalForwarder
  // for why this must be set up BEFORE spawning, and when the child gets its own process
  // group). Most valuable when `varlock run` is a container ENTRYPOINT / PID 1.
  const signalForwarder = createChildSignalForwarder();
  const useProcessGroup = signalForwarder.useProcessGroup;

  if (!redactStdout && !redactStderr) {
    // full stdio inherit - no redaction needed on any stream
    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdio: 'inherit',
      env: fullInjectedEnv,
      detached: useProcessGroup,
    });
  } else {
    resetRedactionMap(serializedGraph);

    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdin: 'inherit',
      stdout: redactStdout ? 'pipe' : 'inherit',
      stderr: redactStderr ? 'pipe' : 'inherit',
      env: fullInjectedEnv,
      detached: useProcessGroup,
    });

    pipeRedactedStreams(commandProcess, { redactStdout, redactStderr });
  }
  signalForwarder.attach(commandProcess);
  // console.log('PARENT PID = ', process.pid);
  // console.log('CHILD PID = ', commandProcess.pid);

  let exitCode: any; // TODO: fix this any
  try {
    const result = await commandProcess;
    exitCode = result.exitCode;
  } catch (error) {
    const err = error as any;
    // console.log('child command error!', error);
    if (err.signal === 'SIGINT' && childCommandKilledFromRestart) {
      // console.log('child command failed due to being killed form restart');
      childCommandKilledFromRestart = false;
      return;
    }

    if (err.signal) {
      // the child was terminated by a signal (often one we just forwarded). this is a
      // normal shutdown path, not a varlock failure — propagate the conventional 128+N
      // status (already computed by exec) without printing the "varlock may be broken" noise.
      exitCode = err.exitCode || 1;
    } else {
      console.log((error as Error).message);
      console.log(`command [${commandToRunStr}] failed`);
      console.log('try running the same command without varlock');
      console.log('if you get a different result, varlock may be the problem...');
      // console.log(`Please report issue here: <${REPORT_ISSUE_LINK}>`);
      exitCode = err.exitCode || 1;
    }
  } finally {
    // child has exited and been reaped: stop forwarding (avoid signaling a recycled pid)
    signalForwarder.detach();
  }

  if (isWatchEnabled) {
    if (!childCommandKilledFromRestart) {
      if (exitCode === 0) {
        console.log('\n✅ command completed successfully');
      } else {
        console.log(`\n💥 command failed - exit code = ${exitCode}`);
      }
    }
  }

  if (!isWatchEnabled) {
    return gracefulExit(exitCode);
  } else {
    console.log('... watching for changes ...');
  }
};
