import { type SerializedEnvGraph } from './serialized-env-graph';
export { type SerializedEnvGraph };

import { checkForConfigErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';
import { initVarlockEnv } from './runtime/env';

export async function load() {
  // TODO: add some options
  const envGraph = await loadVarlockEnvGraph();
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
    const replaceItem = !itemInfo.isSensitive || opts?.includeSensitive;
    if (!replaceItem) continue;
    replacements[`${opts?.objectKey || 'ENV'}.${key}`] = JSON.stringify(envInfo.config[key].value);
  }
  return replacements;
}

export { patchGlobalConsole } from './runtime/patch-console';
export { patchGlobalServerResponse } from './runtime/patch-server-response';
export { patchGlobalResponse } from './runtime/patch-response';
export { ENV } from './runtime/env';
