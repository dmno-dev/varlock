import { loadEnvGraph } from '../env-graph';

export async function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  entryFilePath?: string,
}) {
  const envGraph = await loadEnvGraph({
    ...opts,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  });

  return envGraph;
}
