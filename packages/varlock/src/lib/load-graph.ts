import { loadEnvGraph } from '@env-spec/env-graph';

export async function loadVarlockEnvGraph() {
  const envGraph = await loadEnvGraph({
    afterInit: async (g) => {
      // TODO: register varlock resolver
    },
  });

  return envGraph;
}
