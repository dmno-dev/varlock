import { checkForConfigErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';
import { initVarlockEnv } from './runtime/env';
import { checkBunVersion } from './lib/check-bun-version';
import { cleanupDaemonClient } from './lib/local-encrypt';

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
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // loadFromSerializedGraph(envGraph.getSerializedGraph());
  process.env.__VARLOCK_ENV = JSON.stringify(envGraph.getSerializedGraph());
  initVarlockEnv();
  // Close daemon socket so the process can exit naturally after load() resolves.
  // The socket is unref'd by default (see DaemonClient.connectToSocket), but
  // explicitly closing it here is belt-and-suspenders for runtimes/environments
  // where unref() may not be sufficient.
  cleanupDaemonClient();
  // TODO: return resolved env and schema / meta info
}

/**
 * Close the daemon client socket opened during `load()` or other operations
 * that resolved `keychain(...)` values. This is called automatically by
 * `load()`, but you can call it explicitly if you manage the connection
 * lifecycle yourself.
 */
export function cleanup() {
  cleanupDaemonClient();
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
    const replaceItem = !itemInfo.isSensitive || opts?.includeSensitive;
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
  checkForConfigErrors,
  initVarlockEnv,
};

export { patchGlobalConsole } from './runtime/patch-console';
export { patchGlobalServerResponse } from './runtime/patch-server-response';
export { patchGlobalResponse } from './runtime/patch-response';
export { ENV } from './runtime/env';
export { createDebug, type Debugger } from './lib/debug';
export type { SerializedEnvGraph };
