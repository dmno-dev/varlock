import { openSync, closeSync } from 'node:fs';
import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { serializeEnvValueForProcessEnv } from '../../lib/serialize-env-value';

export const commandSpec = define({
  name: 'run',
  description: 'Run a command with your environment variables injected',
  args: {
    // watch: {
    //   type: 'boolean',
    //   short: 'w',
    //   description: 'Watch mode',
    // },
    'redact-stdout': {
      type: 'boolean',
      negatable: true,
      description: 'Override automatic stdout/stderr redaction: --redact-stdout forces redaction of piped/redirected output (e.g., to override @redactLogs=false) and errors if attached to an interactive terminal; --no-redact-stdout disables redaction entirely. Can also be set via the _VARLOCK_REDACT_STDOUT env var (the flag takes precedence)',
    },
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

/**
 * Parse a tri-state boolean toggle from an env var value.
 * Returns true/false for recognized truthy/falsy values, or undefined when unset
 * or unrecognized (so it can fall through to other logic via `??`).
 */
function parseEnvToggle(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

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
  await envGraph.generateTypesIfNeeded();

  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // will fail above if there are any errors

  // by default @internal items are never handed to the child; --include-internal opts out
  // (e.g. a nested `varlock run` whose own resolution needs a secret-zero token)
  const includeInternal = !!ctx.values['include-internal'];
  const resolvedEnv = envGraph.getResolvedEnvObject({ includeInternal });
  const serializedEnvForProcess: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedEnv)) {
    serializedEnvForProcess[key] = serializeEnvValueForProcessEnv(value);
  }
  const serializedGraph = envGraph.getSerializedGraph();
  const { resetRedactionMap } = await import('../../runtime/env');
  const { createRedactedStreamWriter } = await import('../../runtime/lib/redact-stream');
  // console.log(resolvedEnv);

  // handle deprecated --no-inject-graph flag
  let injectDefault = 'all';
  if (ctx.values['no-inject-graph']) {
    console.warn('[varlock] ⚠️  --no-inject-graph is deprecated, use --inject vars instead');
    injectDefault = 'vars';
  }
  const injectMode = ctx.values.inject ?? injectDefault;
  const validModes = ['all', 'vars', 'blob'];
  if (!validModes.includes(injectMode)) {
    throw new CliExitError(`Invalid --inject mode: "${injectMode}". Must be one of: ${validModes.join(', ')}`);
  }
  const injectVars = injectMode === 'all' || injectMode === 'vars';
  const injectBlob = injectMode === 'all' || injectMode === 'blob';

  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(injectVars ? serializedEnvForProcess : {}),
    __VARLOCK_RUN: '1', // flag for a child process to detect it is running via `varlock run`
    ...(injectBlob ? { __VARLOCK_ENV: JSON.stringify(serializedGraph) } : {}),
  };

  // @internal items must not reach the application. The spread of process.env above can carry
  // an ambiently-set value (e.g. `OP_TOKEN=xxx varlock run ...`), so strip those keys here —
  // unless --include-internal was passed, in which case they were intentionally injected above.
  if (!includeInternal) {
    for (const itemKey of envGraph.sortedConfigKeys) {
      if (envGraph.configSchema[itemKey].isInternal) delete fullInjectedEnv[itemKey];
    }
  }

  // when only injecting the blob, also inject the encryption key so the
  // child process can decrypt it (if encrypted)
  if (injectBlob && !injectVars && process.env._VARLOCK_ENV_KEY) {
    fullInjectedEnv._VARLOCK_ENV_KEY = process.env._VARLOCK_ENV_KEY;
  }

  const redactLogs = serializedGraph.settings?.redactLogs ?? true;
  // tri-state override (true = force on, false = force off, undefined = auto-detect):
  // the --redact-stdout / --no-redact-stdout flag takes precedence, falling back to the
  // _VARLOCK_REDACT_STDOUT env var, otherwise we auto-detect per stream below
  const redactOverride = ctx.values['redact-stdout'] ?? parseEnvToggle(process.env._VARLOCK_REDACT_STDOUT);
  const forceRedact = redactOverride === true;
  const forceNoRedact = redactOverride === false;

  // redacting a TTY-attached stream is not possible without piping it, which breaks
  // interactive/TTY-dependent tools - so we fail loudly rather than silently degrade
  if (forceRedact && (process.stdout.isTTY || process.stderr.isTTY)) {
    throw new CliExitError('Cannot force redaction while output is attached to an interactive terminal', {
      details: [
        'Redaction requires piping stdout/stderr, which breaks tools that need a raw TTY (e.g., claude, psql).',
        'Redaction is applied automatically whenever output is piped or redirected, so you can likely just drop the --redact-stdout flag.',
      ],
    });
  }

  // Explicit flags force redaction on/off; otherwise we auto-detect per stream:
  // streams attached to an interactive terminal are inherited directly, preserving raw TTY
  // behavior for interactive tools (psql, claude, etc.) — a human at the terminal already
  // has access to the secrets. Piped/redirected streams (CI logs, files, pipes) are where
  // leaked output persists, so those are piped through redaction.
  const redactionEnabled = !forceNoRedact && (redactLogs || forceRedact);
  const redactStdout = redactionEnabled && (forceRedact || !process.stdout.isTTY);
  const redactStderr = redactionEnabled && (forceRedact || !process.stderr.isTTY);

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

    // pipe output through redaction writers, which buffer possible partial secrets
    // at chunk boundaries so split secrets are still redacted
    if (redactStdout && commandProcess.stdout) {
      const stdoutWriter = createRedactedStreamWriter(process.stdout);
      commandProcess.stdout.on('data', stdoutWriter.write);
      commandProcess.stdout.on('close', stdoutWriter.flush);
    }
    if (redactStderr && commandProcess.stderr) {
      const stderrWriter = createRedactedStreamWriter(process.stderr);
      commandProcess.stderr.on('data', stderrWriter.write);
      commandProcess.stderr.on('close', stderrWriter.flush);
    }
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
