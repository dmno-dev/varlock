import { loadEnvGraph } from '../env-graph';
import { runWithWorkspaceInfo } from './workspace-utils';
import { readVarlockPackageJsonConfig } from './package-json-config';

export function loadVarlockEnvGraph(opts?: {
  currentEnvFallback?: string,
  /** Explicit entry file path - overrides package.json config */
  entryFilePath?: string,
}) {
  // If no explicit path is provided, check package.json for a configured load path
  const resolvedEntryFilePath = opts?.entryFilePath ?? readVarlockPackageJsonConfig()?.loadPath;

  return runWithWorkspaceInfo(() => loadEnvGraph({
    ...opts,
    entryFilePath: resolvedEntryFilePath,
    afterInit: async (_g) => {
      // TODO: register varlock resolver
    },
  }));
}
