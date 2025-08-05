import { define } from 'gunshi';
import { loadEnvGraph } from '@env-spec/env-graph';
import { isBundledSEA } from '../helpers/install-detection';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'doctor',
  description: 'Debug and diagnose issues with your env file(s) and system',
  args: {},
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.log('');
  await console.log('🧙 Scanning for issues... ✨');

  console.log('Bundled SEA?', isBundledSEA());

  const envGraph = await loadEnvGraph();
  await envGraph.resolveEnvValues();
  // const resolvedEnv = envGraph.getResolvedEnvObject();

  // TODO: Mac app checks
  // - installed, running, logged in, set up (keys exist), locked/unlocked state
};

