import { cli, type Command } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { VARLOCK_BANNER_COLOR } from '../lib/ascii-art';
import { CliExitError } from './helpers/exit-error';
import { fmt } from './helpers/pretty-format';
import { trackCommand, trackInstall } from './helpers/telemetry';
import { InvalidEnvError } from './helpers/error-checks';
import packageJson from '../../package.json';

// we'll import just the spec from each, so the implementations can be lazy loaded
import { commandSpec as initCommandSpec } from './commands/init.command';
import { commandSpec as loadCommandSpec } from './commands/load.command';
import { commandSpec as runCommandSpec } from './commands/run.command';
// import { commandSpec as encryptCommandSpec } from './commands/encrypt.command';
// import { commandSpec as doctorCommandSpec } from './commands/doctor.command';
import { commandSpec as helpCommandSpec } from './commands/help.command';
import { commandSpec as telemetryCommandSpec } from './commands/telemetry.command';
// import { commandSpec as loginCommandSpec } from './commands/login.command';
import { commandSpec as pluginCommandSpec } from './commands/plugin.command';

let versionId = packageJson.version;
if (__VARLOCK_BUILD_TYPE__ !== 'release') versionId += `-${__VARLOCK_BUILD_TYPE__}`;

// TODO: this is not splitting the bundle correctly to actually lazy load the command fns
function buildLazyCommand(
  commandSpec: Command<any>,
  loadCommandFn: () => Promise<{ commandSpec: Command<any>, commandFn: any }>,
) {
  const commandName = commandSpec.name!;
  return {
    ...commandSpec,
    run: async (...args: Array<any>) => {
      // Track command execution
      await trackCommand(commandName, { command: commandName });
      // load the command fn and run it
      const commandSpecAndFn = await loadCommandFn();
      return commandSpecAndFn.commandFn(...args);
    },
  };
}

const subCommands = new Map();
subCommands.set('init', buildLazyCommand(initCommandSpec, async () => await import('./commands/init.command')));
subCommands.set('load', buildLazyCommand(loadCommandSpec, async () => await import('./commands/load.command')));
subCommands.set('run', buildLazyCommand(runCommandSpec, async () => await import('./commands/run.command')));
// subCommands.set('encrypt', buildLazyCommand(encryptCommandSpec, async () => await import('./commands/encrypt.command')));
// subCommands.set('doctor', buildLazyCommand(doctorCommandSpec, async () => await import('./commands/doctor.command')));
subCommands.set('help', buildLazyCommand(helpCommandSpec, async () => await import('./commands/help.command')));
subCommands.set('telemetry', buildLazyCommand(telemetryCommandSpec, async () => await import('./commands/telemetry.command')));
// subCommands.set('login', buildLazyCommand(loginCommandSpec, async () => await import('./commands/login.command')));
subCommands.set('plugin', buildLazyCommand(pluginCommandSpec, async () => await import('./commands/plugin.command')));

(async function go() {
  try {
    let args = process.argv.slice(2);

    // TODO: remove this once we have a better way to re-trigger help
    if (args[0] === 'help') args = ['--help'];

    // track standalone installs via homebrew/curl
    if (__VARLOCK_SEA_BUILD__) {
      if (args[0] === '--post-install') {
        await trackInstall(args[1] as 'brew' | 'curl');
        //! this ouput is used by homebrew formula to check installed version is correct
        console.log(versionId);
        gracefulExit();
      }
    }

    if (args[0] === '--version') {
      await trackCommand('version');
    }

    await cli(args, {
      // main command - triggered if you just run `varlock` with no args
      run: () => {
        console.log('Please run one of the sub-commands. Run `varlock --help` for more info.');
      },
    }, {
      name: 'varlock',
      description: 'Encrypt and protect your env vars',
      version: versionId,
      subCommands,
      renderHeader: async (ctx) => {
        // do not show header if we are running a sub-command
        if (ctx.name) return '';
        return VARLOCK_BANNER_COLOR;
      },
    });
    gracefulExit();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Command not found: ')) {
      const badCommandName = error.message.split(': ')[1];
      const badCommandErr = new CliExitError(`Invalid subcommand: ${badCommandName}`, {
        suggestion: `Run \`${fmt.command('varlock --help', { jsPackageManager: true })}\` for more info.`,
      });
      console.error(badCommandErr.getFormattedOutput());
      gracefulExit(1);
    } else if (error instanceof CliExitError || error instanceof InvalidEnvError) {
      // in watch mode, we just log but do not actually exit
      console.error(error.getFormattedOutput());
      // TODO: we'll probably want to implement watch mode, so it wont actually exit
      // process.exit(1);
      gracefulExit(1);
    } else {
      throw error;
    }

    gracefulExit(1);
  }
}());
