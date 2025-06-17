import { checkForConfigErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';
import { resetRedactionMap } from './lib/redaction-helpers';


let envValues = {} as Record<string, any>;

const EnvProxy = new Proxy({}, {
  get(target, prop) {
    // TODO: yell if prop is symbol
    if (prop in envValues) return envValues[prop.toString()];
  },
});


export const ENV = EnvProxy;

export function loadSync() {
  throw new Error('Not yet supported');
}

export async function load() {
  // TODO: add some options
  // console.log('loading varlock (async)');


  const envGraph = await loadVarlockEnvGraph();
  await envGraph.resolveEnvValues();

  checkForConfigErrors(envGraph);

  const resolvedEnv = envGraph.getResolvedEnvObject();

  resetRedactionMap(envGraph);

  // reset env values
  envValues = {};

  for (const key in resolvedEnv) {
    const resolvedValue = resolvedEnv[key];
    if (resolvedValue === undefined || resolvedValue === null) {
      envValues[key] = undefined;
      process.env[key] = undefined; // not sure what to do here
    } else {
      envValues[key] = resolvedValue;
      process.env[key] = resolvedValue.toString();
    }
  }

  // TODO: return resolved env and schema / meta info
}

// expose redaction utils
export { VarlockRedactor } from './lib/redaction-helpers';
