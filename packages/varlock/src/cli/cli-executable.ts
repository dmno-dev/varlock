import { cli } from 'gunshi';

import { VARLOCK_BANNER, VARLOCK_BANNER_COLOR } from '../lib/ascii-art';
import { CliExitError } from './helpers/exit-error';
import { EnvSourceParseError } from '@env-spec/env-graph';
import ansis from 'ansis';
import { fmt } from './helpers/pretty-format';

// these will be added as sub-commands and will lazy load the command files
const commandNames = [
  'init',
  'load',
  'run',
  'encrypt',
  'doctor',
  'help',
] as const;

const mainCommand = {
  run: () => {
    console.log('Use one of the sub-commands...');
  },
};



const subCommands = new Map();
commandNames.forEach(async (commandName) => {
  subCommands.set(commandName, async () => {
    const commandSpecAndFn = await import(`./commands/${commandName}.command.ts`);
    return {
      ...commandSpecAndFn.commandSpec,
      run: commandSpecAndFn.commandFn,
    };
  });
});
// subCommands.set('subcommand1', { description: 'first subcommand' });
// subCommands.set('subcommand2', { description: 'second subcommand' });

(async function go() {
  try {
    let args = process.argv.slice(2);

    // TODO: remove this once we have a better way to re-trigger help
    if (args[0] === 'help') args = ['--help'];

    await cli(args, mainCommand, {
      name: 'varlock',
      description: 'Encrypt and protect your env vars',
      version: '0.0.1',
      subCommands,
      renderHeader: async (ctx) => {
        // do not show header if we are running a sub-command
        if (ctx.name) return '';
        return VARLOCK_BANNER_COLOR;
      },
    });
    process.exit(0);
  } catch (error) {
    if (error instanceof CliExitError) {
      // in watch mode, we just log but do not actually exit
      console.error(error.getFormattedOutput());
      // TODO: we'll probably want to implement watch mode, so it wont actually exit
    } else if (error instanceof EnvSourceParseError) {
      console.log(`🚨 Error encountered while loading ${error.location.path}`);
      console.log(error.message);

      const errLoc = error.location as any;

      const errPreview = [
        errLoc.lineStr,
        `${ansis.gray('-'.repeat(errLoc.colNumber - 1))}${ansis.red('^')}`,
      ].join('\n');

      console.log('Error parsing .env file');
      console.log(fmt.filePath(`${errLoc.path}:${errLoc.lineNumber}:${errLoc.colNumber}`));
      console.log(errPreview);

      process.exit(1);
    } else {
      throw error;
    }


    process.exit(1);
  }
}());
