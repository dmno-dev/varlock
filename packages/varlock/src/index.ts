import { checkForConfigErrors } from './cli/helpers/error-checks';
import { loadVarlockEnvGraph } from './lib/load-graph';
import { resetRedactionMap } from './lib/redaction-helpers';


let envValues = {} as Record<string, any>;
let publicKeys = [] as Array<string>;

// these types will be overridden/augmented by the generated types
export interface TypedEnvSchema {}
export interface PublicTypedEnvSchema {}

const EnvProxy = new Proxy<TypedEnvSchema>({}, {
  get(target, prop) {
    if (typeof prop !== 'string') throw new Error('prop keys cannot be symbols');
    if (!(prop in envValues)) throw new Error(`Env key \`${prop}\` does not exist`);
    return envValues[prop.toString()];
  },
});
const PublicEnvProxy = new Proxy<PublicTypedEnvSchema>({}, {
  get(target, prop) {
    if (typeof prop !== 'string') throw new Error('prop keys cannot be symbols');
    if (!(prop in envValues)) throw new Error(`Env key \`${prop}\` does not exist`);
    if (!publicKeys.includes(prop.toString())) throw new Error(`${prop.toString()} is sensitive, use ENV instead of PUBLIC_ENV`);
    return envValues[prop.toString()];
  },
});

export const ENV = EnvProxy;
export const PUBLIC_ENV = PublicEnvProxy;

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
  publicKeys = [];

  for (const key in resolvedEnv) {
    if (!envGraph.configSchema[key].isSensitive) publicKeys.push(key);

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
