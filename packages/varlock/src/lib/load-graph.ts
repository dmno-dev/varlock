import { loadEnvGraph } from '@env-spec/env-graph';
import { VarlockNativeAppClient } from './native-app-client';

const varlockNativeAppClient = new VarlockNativeAppClient();

export async function loadVarlockEnvGraph() {
  const envGraph = await loadEnvGraph();

  envGraph.registerResolver('varlock', (args) => {
    // validate function args
    if (!Array.isArray(args) || args.length !== 1) {
      throw new Error('varlock resolver requires a single arg - which must be the encrypted value');
    }
    const [encryptedValue] = args;
    if (typeof encryptedValue !== 'string') {
      throw new Error('expected encrypted value to be a string');
    }

    return {
      icon: '',
      label: 'varlock encrypted value',
      resolve: async (ctx: any) => {
        const decryptedValue = await varlockNativeAppClient.decrypt(encryptedValue);
        return decryptedValue;
      },
    };
  });

  return envGraph;
}
