import { SerializedEnvGraph } from '@env-spec/env-graph';
import { resetRedactionMap } from './redaction-helpers';

let envValues = {} as Record<string, any>;
let publicKeys = [] as Array<string>;

export async function loadFromSerializedGraph(serializedGraph: SerializedEnvGraph) {
  resetRedactionMap(serializedGraph);

  // reset env values
  envValues = {};
  publicKeys = [];

  for (const key in serializedGraph.config) {
    if (!serializedGraph.config[key].isSensitive) publicKeys.push(key);

    const resolvedValue = serializedGraph.config[key].value;
    if (resolvedValue === undefined || resolvedValue === null) {
      envValues[key] = undefined;
      process.env[key] = undefined; // not sure what to do here
    } else {
      envValues[key] = resolvedValue;
      process.env[key] = resolvedValue.toString();
    }
  }
  (globalThis as any).__VARLOCK_ENV_VALUES = envValues;
}

