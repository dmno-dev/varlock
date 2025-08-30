import { execa, type ResultPromise } from 'execa';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import which from 'which';
import { define } from 'gunshi';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { gracefulExit } from 'exit-hook';

export const commandSpec = define({
  name: 'run',
  description: 'Run a command with your environment variables injected',
  args: {
    'exclude-local': {
      type: 'boolean',
      description: 'Exclude .env.local and .env.[env].local from loading',
    },
    'bun-sync-node-env': {
      type: 'boolean',
      description: 'When running Bun, set NODE_ENV to the resolved @envFlag value',
    },
    'respect-existing-env': {
      type: 'boolean',
      description: 'Allow process.env to override schema-defined keys',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @envFlag in the schema if present',
    },
    // watch: {
    //   type: 'boolean',
    //   short: 'w',
    //   description: 'Watch mode',
    // },
  },
});

let commandProcess: ResultPromise | undefined;
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
  const pathAwareCommand = which.sync(rawCommand, { nothrow: true });

  // const isWatchEnabled = ctx.values.watch;
  const isWatchEnabled = false;

  // console.log('running command', pathAwareCommand || rawCommand, commandArgsOnly);


  // pass through options for local files and existing env behavior
  const excludeLocal = ctx.values['exclude-local'] === true ? true : undefined;
  const respectExistingEnv = Boolean(ctx.values['respect-existing-env']);
  const currentEnvFallback = ctx.values.env as string | undefined;
  const envGraph = await loadVarlockEnvGraph({ excludeLocal, respectExistingEnv, currentEnvFallback });
  checkForSchemaErrors(envGraph);
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // will fail above if there are any errors

  const resolvedEnv = envGraph.getResolvedEnvObject();
  // console.log(resolvedEnv);

  // needs more thought here
  function buildChildEnv(resolved: Record<string, any>, mode: 'whitelist' | 'all' | 'none' = 'whitelist') {
    const whitelist = new Set(['PATH', 'HOME', 'SHELL', 'TERM', 'TZ', 'LANG', 'LC_ALL', 'PWD', 'TMPDIR', 'TEMP', 'TMP']);
    let base: Record<string, string> = {};
    if (mode === 'all') {
      base = { ...process.env } as Record<string, string>;
    } else if (mode === 'whitelist') {
      for (const key of whitelist) {
        if (process.env[key] != null) base[key] = String(process.env[key]);
      }
    }
    // mode === 'none' → base remains empty
    const merged: Record<string, string> = { ...base };
    for (const k in resolved) merged[k] = resolved[k] === undefined ? '' : String(resolved[k]);
    merged.__VARLOCK_RUN = '1';
    merged.__VARLOCK_ENV = JSON.stringify(envGraph.getSerializedGraph());
    return merged;
  }

  const fullInjectedEnv = buildChildEnv(resolvedEnv);

  const isBun = (cmd?: string) => (cmd === 'bun' || cmd === 'bunx');
  const finalCommand = pathAwareCommand || rawCommand;
  let finalArgs = commandArgsOnly.slice();

  let emptyEnvPath: string | undefined;
  if (isBun(rawCommand)) {
    // Neutralize Bun dotenv by passing an explicit empty env file
    // Create a temporary empty file to ensure Bun does not auto-load dotenv
    emptyEnvPath = join(tmpdir(), `.varlock-empty-${process.pid}-${Date.now()}.env`);
    try {
      writeFileSync(emptyEnvPath, '');
    } catch (e) {
      // noop
    }
    finalArgs = ['--env-file', emptyEnvPath, ...finalArgs];
    // .env.local handling is resolved in Varlock; Bun dotenv stays disabled
    if (ctx.values['bun-sync-node-env']) {
      const envFlagKey = envGraph.envFlagKey;
      const envFlagVal = envFlagKey ? String(resolvedEnv[envFlagKey] ?? '') : '';
      if (envFlagVal) fullInjectedEnv.NODE_ENV = envFlagVal;
    }
  }

  commandProcess = execa(finalCommand, finalArgs, {
    stdio: 'inherit',
    env: fullInjectedEnv,
  });
  // cleanup temp empty env file after process exits
  commandProcess.finally(() => {
    if (emptyEnvPath) {
      try {
        unlinkSync(emptyEnvPath);
      } catch (e) {
        // noop
      }
    }
  });
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
    const commandResult = await commandProcess;
    exitCode = commandResult.exitCode;
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
      console.log('try running the same command without dmno');
      console.log('if you get a different result, dmno may be the problem...');
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
