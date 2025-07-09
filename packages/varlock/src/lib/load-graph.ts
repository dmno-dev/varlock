import { loadEnvGraph } from '@env-spec/env-graph';

export async function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
}) {
  const envGraph = await loadEnvGraph({
    ...opts,
    afterInit: async (g) => {
      // TODO: register varlock resolver
    },
  });

  return envGraph;
}
