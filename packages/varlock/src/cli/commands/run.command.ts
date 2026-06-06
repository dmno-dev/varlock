import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { buildProxySchemaFingerprint } from '../helpers/proxy-schema-fingerprint';
import { startLocalProxyRuntime } from '../../proxy/runtime-proxy';

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
    },
    proxy: {
      type: 'boolean',
      description: 'Enable proxy placeholder mode for items managed by @proxy rules',
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
  varlock run --proxy -- node app.js            # Inject placeholders for @proxy-managed items
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

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  let proxyRuntime: Awaited<ReturnType<typeof startLocalProxyRuntime>> | undefined;

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

  const resolvedEnv = envGraph.getResolvedEnvObject();
  const serializedGraph = envGraph.getSerializedGraph();
  const { resetRedactionMap } = await import('../../runtime/env');
  const { createRedactedStreamWriter } = await import('../../runtime/lib/redact-stream');

  const proxySchemaFingerprint = ctx.values.proxy ? buildProxySchemaFingerprint(envGraph) : undefined;
  let proxyManagedItems = [] as Array<Awaited<ReturnType<typeof envGraph.getProxyManagedItems>>[number]>;
  let proxyRules = [] as Array<Awaited<ReturnType<typeof envGraph.getProxyRules>>[number]>;

  if (ctx.values.proxy) {
    proxyManagedItems = await envGraph.getProxyManagedItems();
    proxyRules = await envGraph.getProxyRules();
    for (const managedItem of proxyManagedItems) {
      resolvedEnv[managedItem.key] = managedItem.placeholder;
      if (serializedGraph.config[managedItem.key]) {
        serializedGraph.config[managedItem.key].value = managedItem.placeholder;
      }
    }
  }
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
  if (ctx.values.proxy) {
    proxyRuntime = await startLocalProxyRuntime({
      managedItems: proxyManagedItems,
      rules: proxyRules,
      egressMode: serializedGraph.settings?.proxyEgress ?? 'permissive',
    });
  }

  const fullInjectedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(proxyRuntime?.env ?? {}),
    ...(injectVars ? resolvedEnv : {}),
    __VARLOCK_RUN: '1', // flag for a child process to detect it is running via `varlock run`
    ...(ctx.values.proxy
      ? {
        __VARLOCK_PROXY_CHILD: '1',
        __VARLOCK_PROXY_PARENT_PID: String(process.pid),
        ...(proxySchemaFingerprint ? { __VARLOCK_PROXY_SCHEMA_FINGERPRINT: proxySchemaFingerprint } : {}),
      }
      : {}),
    ...(injectBlob ? { __VARLOCK_ENV: JSON.stringify(serializedGraph) } : {}),
  };

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

  if (!redactStdout && !redactStderr) {
    // full stdio inherit - no redaction needed on any stream
    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdio: 'inherit',
      env: fullInjectedEnv,
    });
  } else {
    // augment the redaction map with the real (injected-by-proxy) secret values so that
    // any real value leaking back through the child's output is still redacted, even
    // though the child only ever sees placeholders
    const redactionGraph = {
      ...serializedGraph,
      config: { ...serializedGraph.config },
    };
    if (ctx.values.proxy) {
      for (const managedItem of proxyManagedItems) {
        const schemaItem = serializedGraph.config[managedItem.key];
        if (!schemaItem?.isSensitive) continue;
        if (!managedItem.realValue || managedItem.realValue === schemaItem.value) continue;
        redactionGraph.config[`__PROXY_REAL__${managedItem.key}`] = {
          value: managedItem.realValue,
          isSensitive: true,
        };
      }
    }
    resetRedactionMap(redactionGraph);

    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdin: 'inherit',
      stdout: redactStdout ? 'pipe' : 'inherit',
      stderr: redactStderr ? 'pipe' : 'inherit',
      env: fullInjectedEnv,
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

  // if first run, we need to attach some extra exit handling
  if (!isWatchModeRestart) {
    // try to make sure we shut down cleanly and kill the child process
    process.on('exit', (_code: any, _signal: any) => {
      // if (childCommandKilledFromRestart) {
      //   childCommandKilledFromRestart = false;
      //   return;
      // }
      // console.log('exit!', code, signal);
      commandProcess?.kill(9);
    });

    ['SIGTERM', 'SIGINT'].forEach((signal) => {
      process.on(signal, () => {
        // console.log('SIGNAL = ', signal);
        commandProcess?.kill(9);
        gracefulExit(1);
      });
    });
    // TODO: handle other signals?
  }


  let exitCode: any; // TODO: fix this any
  try {
    const result = await commandProcess;
    exitCode = result.exitCode;
  } catch (error) {
    // console.log('child command error!', error);
    if ((error as any).signal === 'SIGINT' && childCommandKilledFromRestart) {
      // console.log('child command failed due to being killed form restart');
      childCommandKilledFromRestart = false;
      await proxyRuntime?.stop();
      return;
    }

    // console.log('child command result error', error);
    if ((error as any).signal === 'SIGINT' || (error as any).signal === 'SIGKILL') {
      gracefulExit(1);
    } else {
      console.log((error as Error).message);
      console.log(`command [${commandToRunStr}] failed`);
      console.log('try running the same command without varlock');
      console.log('if you get a different result, varlock may be the problem...');
      // console.log(`Please report issue here: <${REPORT_ISSUE_LINK}>`);
    }
    exitCode = (error as any).exitCode || 1;
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
    await proxyRuntime?.stop();
    return gracefulExit(exitCode);
  } else {
    await proxyRuntime?.stop();
    console.log('... watching for changes ...');
  }
};
