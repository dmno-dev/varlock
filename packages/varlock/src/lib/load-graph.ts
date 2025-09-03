import { loadEnvGraph } from '../../env-graph';

export async function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  excludeLocal?: boolean,
  respectExistingEnv?: boolean,
}) {
  const envGraph = await loadEnvGraph({
    ...opts,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  });

  return envGraph;
}
