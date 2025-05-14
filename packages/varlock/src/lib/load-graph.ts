import { loadEnvGraph } from '@env-spec/env-graph';
import { VarlockResolver } from './native-app-resolver';

export async function loadVarlockEnvGraph() {
  const envGraph = await loadEnvGraph({
    afterInit: async (g) => {
      // registers our varlock() fn which talks to the native app
      g.registerResolver(VarlockResolver);
    },
  });

  return envGraph;
}
