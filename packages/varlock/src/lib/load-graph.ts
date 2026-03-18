import { loadEnvGraph } from '../env-graph';
import { runWithWorkspaceInfo } from './workspace-utils';

export function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  entryFilePath?: string,
}) {
  return runWithWorkspaceInfo(() => loadEnvGraph({
    ...opts,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  }));
}
