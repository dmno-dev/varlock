import { cli, define, type Command } from 'gunshi';
import { loadEnvGraph } from '../../env-graph';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { checkForSchemaErrors } from '../helpers/error-checks';
import type { VarlockPlugin } from '../../env-graph/lib/plugins';
import { execSync, fork } from 'child_process';
import { executeVarlockPluginCli } from '../plugin-cli-lib';

export const commandSpec = define({
  name: 'plugin',
  description: 'Run a CLI command for an installed plugin',
  args: {
    pluginName: {
      type: 'string',
      short: 'n',
      description: 'Name of the plugin to run a command for',
    },
    pluginPackageName: {
      type: 'string',
      short: 'p',
      description: 'Package name of the plugin to run a command for',
    },
  },
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadEnvGraph();
  checkForSchemaErrors(envGraph);
  await envGraph.resolveEnvValues();

  // console.log(envGraph.plugins);

  // const resolvedEnv = envGraph.getResolvedEnvObject();

  const { pluginName, pluginPackageName } = ctx.values;

  if (!pluginName && !pluginPackageName) {
    console.log([
      'You must specify which plugin to run a command for',
      'You may use the -n to sprify a short id, or -p to use the full package name',
      '',
      'Currently installed plugins:',
      envGraph.plugins.map((p) => `- ${p.name} (package name = ${p.packageName})`).join('\n'),
    ].join('\n'));
    process.exit(1);
  }

  let selectedPlugin: VarlockPlugin | undefined;
  if (pluginName && pluginPackageName) {
    console.log('You cannot specify both a plugin name (-n) and a package name (-p)');
    process.exit(1);
  } else if (pluginName) {
    selectedPlugin = envGraph.plugins.find((p) => p.name === pluginName);
  } else if (pluginPackageName) {
    selectedPlugin = envGraph.plugins.find((p) => p.packageName === pluginPackageName);
  }

  if (!selectedPlugin) {
    console.log(`Plugin "${pluginName || pluginPackageName}" not found`);
    console.log([
      '',
      'Please select one of the following plugins:',
      envGraph.plugins.map((p) => `- ${p.name} (package name = ${p.packageName})`).join('\n'),
    ].join('\n'));
    process.exit(1);
  }

  if (!selectedPlugin.pluginCliFilePath) {
    console.log(`Plugin "${selectedPlugin.name}" does not have any CLI commands`);
    process.exit(1);
  }


  const argv = process.argv.slice(2);
  let restCommandArgs: Array<string> = [];
  if (argv.includes('--')) {
    const doubleDashIndex = argv.indexOf('--');
    restCommandArgs = argv.slice(doubleDashIndex + 1);
  } else {
    throw new Error('No command to run! Your command should look like `varlock run -- <your-command>`');
  }
  const pluginCliArgs = restCommandArgs;
  const pluginCliArgsAsStr = restCommandArgs.join(' ');

  console.log('>> plugin cli args:', pluginCliArgsAsStr);

  try {
    console.log(selectedPlugin.pluginCliFilePath);
    const pluginCliModule = await import(selectedPlugin.pluginCliFilePath);
    const pluginDef = await pluginCliModule.default(envGraph);

    console.log('loaded plugin cli commands', pluginDef.commands);
    await executeVarlockPluginCli(pluginCliArgs, pluginDef.commands);

  } catch (err) {
    console.error('Error importing plugin CLI module:', err);
    process.exit(1);
  }

  // await pluginCliModule.default(pluginCliArgs);

  // const childCliProcess = fork(selectedPlugin.pluginCliFilePath, pluginCliArgs);
  // childCliProcess.send({
  //   pluginName: selectedPlugin.name,
  //   pluginPackageName: selectedPlugin.packageName,
  //   pluginVersion: selectedPlugin.version,
  //   pluginCliCtx: selectedPlugin.cliCtx,
  // });
};

