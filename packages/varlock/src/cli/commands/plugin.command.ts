import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { checkForSchemaErrors } from '../helpers/error-checks';
import { commandSpec } from './plugin.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  await console.log('🧙 Scanning for issues... ✨');

  const envGraph = await loadVarlockEnvGraph();
  checkForSchemaErrors(envGraph);
  await envGraph.resolveEnvValues();
  // const resolvedEnv = envGraph.getResolvedEnvObject();

  const { pluginId, command } = ctx.values;

  console.log(`>> plugin command: ${pluginId} / ${command}`);

  console.log('NOT IMPLEMENTED YET');

  // TODO: call out to plugins CLI capabilities
  // for example `varlock plugin simple-vault init` would init a new encryption key
};

