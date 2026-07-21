import { openSync, closeSync } from 'node:fs';
import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { isVarlockReservedKey } from '../../env-graph/lib/reserved-vars';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { getCliItemFilter } from '../helpers/item-filter';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { REDACT_STDOUT_ARG, resolveStdoutRedaction, pipeRedactedStreams } from '../helpers/stdout-redaction';
import { buildInjectedBlobEnv } from '../helpers/injected-env-blob';
import { resolveInjectMode } from '../helpers/inject-mode';

export const commandSpec = define({
  name: 'run',
  description: 'Run a command with your environment variables injected',
  args: {
    // watch: {
    //   type: 'boolean',
    //   short: 'w',
    //   description: 'Watch mode',
    // },
    ...REDACT_STDOUT_ARG,
    inject: {
      type: 'string',
      short: 'i',
      description: 'Control what gets injected into the child process env: "all" (default), "vars" (individual vars only, no blob), or "blob" (only __VARLOCK_ENV blob, no individual vars)',
    },
    'no-inject-graph': {
      type: 'boolean',
      description: 'Deprecated: use --inject vars instead',
      hidden: true,
    },
    'include-internal': {
      type: 'boolean',
      description: 'Pass @internal items through to the child process (by default they are stripped, even when set in the ambient env). Use this for a nested `varlock run` whose own resolution needs the internal value (e.g. a secret-zero token).',
    },
    filter: {
      type: 'string',
      description: 'Filter which items are injected: comma-separated key names/globs (e.g. STRIPE_*), negations (!KEY), decorator selectors (@sensitive, @required), and tag selectors (#tagname, set via @tag(tagname)). Can also be set via the _VARLOCK_FILTER env var (this flag takes precedence)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    'clear-cache': {
      type: 'boolean',
      description: 'Clear cache and re-resolve all values',
    },
    'skip-cache': {
      type: 'boolean',
      description: 'Skip cache entirely for this invocation',
    },
  },
  examples: `
Executes a command in a child process, injecting your resolved and validated environment
variables from your .env files. Useful when a code-level integration is not possible.

Examples:
  varlock run -- node app.js                    # Run a Node.js application
  varlock run -- python script.py               # Run a Python script
  varlock run -- sh -c 'echo $MY_VAR'           # Use shell expansion for env vars
  varlock run --inject vars -- sh               # Inject only individual vars, no blob
  varlock run --inject blob -- node app.js      # Inject only the blob, no individual vars
  varlock run --path .env.prod -- node app.js   # Use a specific .env file
  varlock run --path ./config/ -- node app.js   # Use a specific directory
  varlock run -p ./envs -p ./overrides -- node app.js  # Use multiple directories
  varlock run --filter="STRIPE_*,!STRIPE_DEBUG_KEY" -- node app.js  # Only inject STRIPE_* keys, excluding one

📍 Important: Use -- to separate varlock options from your command

💡 Tip: For shell expansion of env vars, use: sh -c 'your command here'
💡 Tip: Output redaction applies automatically when output is piped/redirected (e.g., CI logs);
   interactive terminals get raw TTY pass-through, so tools like psql and claude just work.
   Use --no-redact-stdout to disable redaction for piped output, or --redact-stdout to
   force it (e.g., to override @redactLogs=false).
💡 Tip: Use --inject vars to prevent __VARLOCK_ENV from being visible in child process env
💡 Tip: Use --inject blob when your app uses the ENV proxy and doesn't need individual process.env vars
  `.trim(),
});

let commandProcess: ReturnType<typeof exec> | undefined;
let childCommandKilledFromRestart = false;
const isWatchModeRestart = false; // TODO: re-enable watch mode

// whether the child was spawned in its own process group, so we can signal the
// whole group (child + grandchildren) rather than just the immediate child
let childInOwnProcessGroup = false;
// set once the child has exited and been reaped, so we never signal a stale (and
// possibly recycled) pid/process group afterwards
let childExited = false;
// optional opt-in fallback timer that escalates to SIGKILL (see FORCE_KILL_TIMEOUT_MS)
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

// signals we forward to the child so it can shut down gracefully. these are the
// terminating signals an orchestrator (docker stop, k8s, a shell) would send.
const FORWARDED_SIGNALS: Array<NodeJS.Signals> = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

// By default we forward-and-wait (like tini/dumb-init) and never impose our own kill
// deadline — the orchestrator/operator owns SIGKILL, and a timer would wrongly assume
// every forwarded signal is terminal (SIGHUP often means "reload") and could truncate a
// legitimately-slow graceful shutdown. Opt in by setting _VARLOCK_FORCE_KILL_TIMEOUT_MS
// to a number of milliseconds to escalate to SIGKILL that long after the first signal.
const FORCE_KILL_TIMEOUT_MS = (() => {
  const raw = process.env._VARLOCK_FORCE_KILL_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
})();

/**
 * Whether this process is part of a terminal session — i.e. has a controlling terminal.
 *
 * We can't just check `isTTY` on the std streams: a process can keep its controlling
 * terminal while its std fds are pipes (e.g. a task runner like turbo running
 * interactively but piping a task's output instead of giving it a PTY). The daemon's
 * session scoping keys off the controlling terminal (`e_tdev`), not fd tty-ness, so we
 * use the canonical POSIX probe — `/dev/tty` opens iff a controlling terminal exists —
 * with the std-stream check as a fast path.
 */
function hasControllingTerminal(): boolean {
  if (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) return true;
  if (process.platform === 'win32') return false; // no /dev/tty; we never setsid on Windows anyway
  try {
    const fd = openSync('/dev/tty', 'r');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forward a signal to the running child process. When the child lives in its own
 * process group we signal the whole group (negative pid) so grandchildren are
 * terminated too; otherwise we signal the child pid directly. Never signals once the
 * child has exited, to avoid hitting a recycled pid/process group.
 */
function signalChild(signal: NodeJS.Signals | number) {
  const child = commandProcess;
  if (childExited || !child?.pid) return;
  try {
    if (childInOwnProcessGroup && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // child (or its group) is already gone — nothing to forward to
  }
}

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


  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Generate types before resolving values — uses only non-env-specific schema info
  await envGraph.runCodeGeneratorsIfNeeded();

  // A --filter using only keys/globs/tags scopes resolution (and validation) to what it
  // selects plus dependencies — an unrelated broken item outside the filter won't block this
  // run. @sensitive/@required selectors can't be scoped this way (see getResolveKeys), so
  // those fall back to resolving everything, same as an unset --filter.
  const itemFilter = getCliItemFilter(ctx.values.filter);
  await envGraph.resolveEnvValues(itemFilter?.getResolveKeys(envGraph));
  checkForConfigErrors(envGraph);

  // will fail above if there are any errors

  // by default @internal items are never handed to the child; --include-internal opts out
  // (e.g. a nested `varlock run` whose own resolution needs a secret-zero token)
  const includeInternal = !!ctx.values['include-internal'];
  const filterKeys = itemFilter?.getFilterKeys(Object.values(envGraph.configSchema));
  // string-serialized values (composites become separator-joined/JSON strings) since
  // these are injected directly into the child's process.env
  const resolvedEnv = envGraph.getResolvedEnvStringObject({ includeInternal, filterKeys });
  const serializedGraph = envGraph.getSerializedGraph({ filterKeys });
  const { resetRedactionMap } = await import('../../runtime/env');
  // console.log(resolvedEnv);

  // handle deprecated --no-inject-graph flag
  let injectDefault = 'all';
  if (ctx.values['no-inject-graph']) {
    console.warn('[varlock] ⚠️  --no-inject-graph is deprecated, use --inject vars instead');
    injectDefault = 'vars';
  }
  const { injectVars, injectBlob } = resolveInjectMode(ctx.values.inject, injectDefault as 'all' | 'vars');

  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(injectVars ? resolvedEnv : {}),
    __VARLOCK_RUN: '1', // flag for a child process to detect it is running via `varlock run`
    // honors @encryptInjectedEnv in blob-only mode; reuses/forwards an ambient key
    ...buildInjectedBlobEnv({
      serializedGraph,
      injectVars,
      injectBlob,
      ambientEnvKey: process.env._VARLOCK_ENV_KEY,
    }),
  };

  // @internal items must not reach the application. The spread of process.env above can carry
  // an ambiently-set value (e.g. `OP_TOKEN=xxx varlock run ...`), so strip those keys here —
  // unless --include-internal was passed, in which case they were intentionally injected above.
  if (!includeInternal) {
    for (const itemKey of envGraph.sortedConfigKeys) {
      if (envGraph.configSchema[itemKey].isInternal) delete fullInjectedEnv[itemKey];
    }
  }

  // Same ambient-carry problem for --filter: an excluded schema key set in the calling env
  // (e.g. `STRIPE_DEBUG_KEY=x varlock run --filter='!STRIPE_DEBUG_KEY' ...`) would otherwise pass
  // straight through the process.env spread — and since excluded items are also left out of the
  // redaction map, it would even print unredacted. Reserved _VARLOCK_* keys configure varlock's
  // own behavior (incl. in nested runs) and are never subject to --filter.
  if (filterKeys) {
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

  // Run the child in its own process group (setsid) only when NO std stream is a TTY —
  // i.e. containers, CI, and background/agent invocations. Detaching is what lets us
  // forward a signal to the whole group so grandchildren shut down too (most valuable
  // when `varlock run` is a container ENTRYPOINT / PID 1).
  //
  // We deliberately gate on "no controlling terminal" rather than just stdin so detaching
  // never has a downside:
  //  - No-terminal context (containers, CI, agents): setsid changes neither env vars nor
  //    parent PIDs, and there's no controlling terminal to lose, so the daemon's
  //    peer/session scoping (env-anchored for agents, or process-tree) is unaffected.
  //  - Terminal context: we stay in the shared group, preserving the child's controlling
  //    terminal — needed for interactive tools (psql, vim, claude), /dev/tty access,
  //    SIGWINCH, and the enclave's tty-based session scoping of any nested varlock (incl.
  //    fan-out runners like turbo whose per-task PTYs we must not sever).
  const useProcessGroup = !hasControllingTerminal();
  childInOwnProcessGroup = useProcessGroup && process.platform !== 'win32';

  // Install signal handling BEFORE spawning the child. This both (a) closes the window
  // where a signal arriving between spawn and handler-registration would kill varlock
  // without forwarding, and (b) ensures varlock holds a real handler for these signals at
  // fork time, so the child inherits the default disposition (SIG_DFL) rather than an
  // inherited "ignored" state — otherwise the child can't react to a forwarded signal.
  if (!isWatchModeRestart) {
    // last-resort cleanup: only if we exit while the child is somehow still alive (e.g. an
    // unexpected error in varlock itself). once the child has exited, signalChild is a no-op,
    // so a clean run never blasts SIGKILL at a reaped (possibly recycled) process group.
    process.on('exit', () => {
      signalChild('SIGKILL');
    });

    // forward terminating signals to the child instead of killing it outright, so it can
    // run its own shutdown handlers. we then wait (below, by awaiting commandProcess) for
    // the child to exit and propagate its real status — rather than exiting immediately and
    // losing both the graceful shutdown and the true exit code. we deliberately do NOT
    // impose our own kill deadline by default (see FORCE_KILL_TIMEOUT_MS).
    FORWARDED_SIGNALS.forEach((signal) => {
      try {
        process.on(signal, () => {
          signalChild(signal);
          // opt-in only: escalate to SIGKILL if the child hasn't exited in time
          if (FORCE_KILL_TIMEOUT_MS !== undefined && !forceKillTimer) {
            forceKillTimer = setTimeout(() => signalChild('SIGKILL'), FORCE_KILL_TIMEOUT_MS);
            // don't let the fallback timer keep the process alive on its own
            forceKillTimer.unref();
          }
        });
      } catch {
        // some signals (e.g. SIGQUIT) can't be listened for on every platform — skip those
      }
    });
  }

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
    // and cancel any pending force-kill escalation
    childExited = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
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
