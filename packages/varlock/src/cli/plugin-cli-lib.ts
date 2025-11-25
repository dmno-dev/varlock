import { cli, type Command } from 'gunshi';
export { define as defineSubcommand } from 'gunshi';

import { createDeferredPromise, type DeferredPromise } from '@env-spec/utils/defer';
import type { EnvGraph } from '../env-graph';

export let pluginCliCtx: any;

export async function executeVarlockPluginCli(
  args: Array<string>,
  subCommands: Array<Command>,
) {
  console.log('executing plugin cli', args, subCommands);

  // TODO: get plugin name and version from package.json
  // or get it passed in from parent command

  let pluginName!: string;
  let pluginPackageName!: string;
  let pluginVersion!: string;

  const initMessageDeferred = createDeferredPromise<void>();

  // process.on('message', (payload: {
  //   pluginName: string,
  //   pluginPackageName: string,
  //   pluginVersion: string,
  //   pluginCliCtx: any,
  // }) => {
  //   console.log('Message from parent:', payload);

  //   pluginName = payload.pluginName;
  //   pluginPackageName = payload.pluginPackageName;
  //   pluginVersion = payload.pluginVersion;
  //   pluginCliCtx = payload.pluginCliCtx;

  //   initMessageDeferred.resolve();

  //   // Send a message back to the parent
  //   // process.send?.({ response: 'Message received by child.' });
  // });


  const mainCommand = {
    name: 'main',
    description: 'Run a plugin CLI subcommand',
    run: () => {
      console.log('Please run one of the sub-commands:');
      subCommands.forEach((subCommand) => {
        console.log(`- ${subCommand.name!} -`, subCommand.description);
      });
    },
  };

  // wait to receive some info from the parent process which has loaded the plugin and the graph
  // await initMessageDeferred.promise;

  await cli(args, mainCommand, {
    name: `varlock plugin -n ${pluginName} --`,
    version: pluginVersion,
    subCommands: new Map(subCommands.map((command) => {
      if (!command.name) throw new Error('Expected subcommand to have a name');
      return [command.name, command];
    })),
  });
}


export function defineVarlockPluginCli(
  def: (envGraph: EnvGraph) => Promise<{ commands: Array<Command> }>,
) {
  return def;
}
