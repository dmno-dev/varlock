import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { exec } from '../../lib/exec';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { resetRedactionMap, redactSensitiveConfig } from '../../runtime/env';

export const commandSpec = define({
  name: 'run',
  description: 'Run a command with your environment variables injected',
  args: {
    // watch: {
    //   type: 'boolean',
    //   short: 'w',
    //   description: 'Watch mode',
    // },
    'no-redact-stdout': {
      type: 'boolean',
      description: 'Disable stdout/stderr redaction and use stdio inherit for full TTY pass-through (use for interactive tools that require raw TTY)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
  },
  examples: `
Executes a command in a child process, injecting your resolved and validated environment
variables from your .env files. Useful when a code-level integration is not possible.

Examples:
  varlock run -- node app.js                    # Run a Node.js application
  varlock run -- python script.py               # Run a Python script
  varlock run -- sh -c 'echo $MY_VAR'           # Use shell expansion for env vars
  varlock run --no-redact-stdout -- psql        # Preserve TTY for interactive tools
  varlock run --path .env.prod -- node app.js   # Use a specific .env file
  varlock run --path ./config/ -- node app.js   # Use a specific directory
  varlock run -p ./envs -p ./overrides -- node app.js  # Use multiple directories

📍 Important: Use -- to separate varlock options from your command

💡 Tip: For shell expansion of env vars, use: sh -c 'your command here'
💡 Tip: Use --no-redact-stdout for interactive tools that require raw TTY (e.g., psql, claude)
  `.trim(),
});

let commandProcess: ReturnType<typeof exec> | undefined;
let childCommandKilledFromRestart = false;
const isWatchModeRestart = false; // TODO: re-enable watch mode

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
  // console.log(resolvedEnv);

  // needs more thought here
  const fullInjectedEnv = {
    ...process.env,
    ...resolvedEnv,
    __VARLOCK_RUN: '1', // flag for a child process to detect it is runnign via `varlock run`
    __VARLOCK_ENV: JSON.stringify(serializedGraph),
  };

  const redactLogs = serializedGraph.settings?.redactLogs ?? true;
  const noRedactStdout = ctx.values['no-redact-stdout'] ?? false;

  // Initialize the redaction map if redaction is enabled
  if (redactLogs) {
    resetRedactionMap(serializedGraph);
  }

  // When --no-redact-stdout is set, use stdio: 'inherit' to preserve TTY detection
  // Otherwise, pipe stdout/stderr through redaction
  if (noRedactStdout) {
    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdio: 'inherit',
      env: fullInjectedEnv,
    });
  } else {
    // When piping for redaction, preserve color support by injecting FORCE_COLOR if the
    // parent stdout is a TTY and colors are not explicitly disabled. This allows tools
    // that respect FORCE_COLOR (chalk, kleur, etc.) to still output colors even when piped.
    // We read terminal env vars (NO_COLOR, FORCE_COLOR, COLORTERM, TERM) from process.env
    // since these are set by the parent shell/terminal, not by varlock config.
    let redactEnv: NodeJS.ProcessEnv = fullInjectedEnv;
    if (
      process.stdout.isTTY
      && process.env.NO_COLOR === undefined
      && process.env.FORCE_COLOR === undefined
    ) {
      let forceColorLevel = '1';
      if (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit') {
        forceColorLevel = '3';
      } else if (process.env.TERM?.includes('256color') || process.env.TERM_PROGRAM === 'iTerm.app') {
        forceColorLevel = '2';
      }
      redactEnv = { ...fullInjectedEnv, FORCE_COLOR: forceColorLevel };
    }

    // Helper to redact and write output
    const writeRedacted = (stream: NodeJS.WriteStream, chunk: Buffer | string) => {
      const str = chunk.toString();
      stream.write(redactLogs ? redactSensitiveConfig(str) : str);
    };

    commandProcess = exec(rawCommand, commandArgsOnly, {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      env: redactEnv,
    });

    // Pipe stdout and stderr through redaction
    commandProcess.stdout?.on('data', (chunk: Buffer | string) => writeRedacted(process.stdout, chunk));
    commandProcess.stderr?.on('data', (chunk: Buffer | string) => writeRedacted(process.stderr, chunk));
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
    return gracefulExit(exitCode);
  } else {
    console.log('... watching for changes ...');
  }
};
