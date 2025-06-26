import { SerializedEnvGraph } from '@env-spec/env-graph';
export { SerializedEnvGraph };

import { checkForConfigErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';

export { ENV, TypedEnvSchema, PublicTypedEnvSchema } from './env';

export async function load() {
  // TODO: add some options
  const envGraph = await loadVarlockEnvGraph();
  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph);

  // loadFromSerializedGraph(envGraph.getSerializedGraph());
  process.env.__VARLOCK_ENV = JSON.stringify(envGraph.getSerializedGraph());

  // TODO: return resolved env and schema / meta info
}

// expose redaction utils
export {
  VarlockRedactor, resetRedactionMap, scanForLeaks,
} from './lib/redaction-helpers';

// expose patching utils
export {
  patchServerResponseToPreventClientLeaks,
} from './lib/patch-server-response';

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

