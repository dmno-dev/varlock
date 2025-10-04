import { define } from 'gunshi';
import { loadEnvGraph } from '../../../env-graph';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'plugin',
  description: 'Run a cli command for an installed plugin',
  args: {
    pluginId: { type: 'positional', description: 'ID of the plugin to run a command for' },
    command: { type: 'positional', description: 'Command to run for the plugin' },
  },
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  await console.log('🧙 Scanning for issues... ✨');

  const envGraph = await loadEnvGraph();
  await envGraph.resolveEnvValues();
  // const resolvedEnv = envGraph.getResolvedEnvObject();

  const { pluginId, command } = ctx.values;

  console.log(`>> plugin command: ${pluginId} / ${command}`);

  console.log('NOT IMPLEMENTED YET');

  // TODO: call out to plugins CLI capabilities
  // for example `varlock plugin simple-vault init` would init a new encryption key
};

