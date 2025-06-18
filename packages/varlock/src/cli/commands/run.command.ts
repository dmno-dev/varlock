import { execa, type ResultPromise } from 'execa';
import which from 'which';
import { define } from 'gunshi';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';
import { TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';


export const commandSpec = define({
  name: 'run',
  description: 'Run a command with the environment variables loaded from the .env file',
  args: {
    watch: {
      type: 'boolean',
      short: 'w',
      description: 'Watch mode',
    },
  },
});

let commandProcess: ResultPromise | undefined;
let childCommandKilledFromRestart = false;
let isWatchModeRestart = false;

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // if "--" is present, split the args into our command and the rest, which will be another external command
  const argv = process.argv.slice(2);
  let commandArgs: Array<string> = [];
  let restCommandArgs: Array<string> = [];
  if (argv.includes('--')) {
    const doubleDashIndex = argv.indexOf('--');
    commandArgs = argv.slice(0, doubleDashIndex);
    restCommandArgs = argv.slice(doubleDashIndex + 1);
  } else {
    throw new Error('No command to run! Your command should look like `varlock run -- <your-command>`');
  }
  const commandToRunAsArgs = restCommandArgs;
  const commandToRunStr = restCommandArgs.join(' ');

  const rawCommand = commandToRunAsArgs[0];
  const commandArgsOnly = commandToRunAsArgs.slice(1);
  const pathAwareCommand = which.sync(rawCommand, { nothrow: true });

  const isWatchEnabled = ctx.values.watch;

  // console.log('running command', pathAwareCommand || rawCommand, commandArgsOnly);


  const envGraph = await loadVarlockEnvGraph();
  checkForSchemaErrors(envGraph);
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // will fail above if there are any errors

  const resolvedEnv = envGraph.getResolvedEnvObject();
  // console.log(resolvedEnv);

  // needs more thought here
  const fullInjectedEnv = {
    ...process.env,
    ...resolvedEnv,
    _VARLOCK_RUN: '1', // flag so we know our env is already injected
  };

  commandProcess = execa(pathAwareCommand || rawCommand, commandArgsOnly, {
    stdio: 'inherit',
    env: fullInjectedEnv,
  });
  // console.log('PARENT PID = ', process.pid);
  // console.log('CHILD PID = ', commandProcess.pid);

  // if first run, we need to attach some extra exit handling
  if (!isWatchModeRestart) {
    // try to make sure we shut down cleanly and kill the child process
    process.on('exit', (code: any, signal: any) => {
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
        process.exit(1);
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
      process.exit(1);
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
    process.exit(exitCode);
  } else {
    console.log('... watching for changes ...');
    // TODO: watch for changes and restart the command
  }
};
