import { checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';
import { initVarlockEnv } from './runtime/env';
import { checkBunVersion } from './lib/check-bun-version';

// Import env-graph components for internal API
import {
  EnvGraph,
  loadEnvGraph,
  DotEnvFileDataSource,
  ConfigLoadError,
  SchemaError,
  ValidationError,
  CoercionError,
  ResolutionError,
  type SerializedEnvGraph,
} from './env-graph';

export async function load() {
  checkBunVersion();
  // TODO: add some options
  const envGraph = await loadVarlockEnvGraph();
  // report loading/schema errors before resolving - a source that failed to load leaves the
  // graph half-built, and resolving it produces confusing downstream errors rather than the
  // parse error that actually caused them (same order the CLI commands use)
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // loadFromSerializedGraph(envGraph.getSerializedGraph());
  process.env.__VARLOCK_ENV = JSON.stringify(envGraph.getSerializedGraph());
  initVarlockEnv();
  // TODO: return resolved env and schema / meta info
}


export function getBuildTimeReplacements(opts?: {
  objectKey?: string,
  includeSensitive?: boolean,
}) {
  if (!process.env.__VARLOCK_ENV) return {};
  const envInfo = JSON.parse(process.env.__VARLOCK_ENV) as SerializedEnvGraph;
  const replacements = {} as Record<string, string>;
  for (const key in envInfo.config) {
    const itemInfo = envInfo.config[key];
    const isDynamic = itemInfo.isDynamic ?? itemInfo.isSensitive;
    const replaceItem = !isDynamic || opts?.includeSensitive;
    if (!replaceItem) continue;
    replacements[`${opts?.objectKey || 'ENV'}.${key}`] = JSON.stringify(envInfo.config[key].value);
  }
  return replacements;
}

// Internal API for direct env graph manipulation
export const internal = {
  // Core classes
  EnvGraph,
  DotEnvFileDataSource,

  // Loader function
  loadEnvGraph,

  // Error classes
  ConfigLoadError,
  SchemaError,
  ValidationError,
  CoercionError,
  ResolutionError,

  // Varlock-specific utilities
  loadVarlockEnvGraph,
  // must run before resolveEnvValues() - a source that failed to load leaves the graph
  // half-built, and checkForConfigErrors() alone never reports source-level parse errors
  checkForSchemaErrors,
  checkForConfigErrors,
  initVarlockEnv,
};

export { patchGlobalConsole } from './runtime/patch-console';
export { patchGlobalServerResponse } from './runtime/patch-server-response';
export { patchGlobalResponse } from './runtime/patch-response';
export { createDebug, type Debugger } from './lib/debug';
export type { SerializedEnvGraph };
