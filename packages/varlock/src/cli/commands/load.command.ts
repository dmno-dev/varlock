import { define } from 'gunshi';
import _ from '@env-spec/utils/my-dash';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'load',
  description: 'Load env according to schema and resolve values',
  args: {
    format: {
      type: 'enum',
      short: 'f',
      choices: ['pretty', 'json', 'env', 'json-full'],
      description: 'Format of output',
      default: 'pretty',
    },
    'show-all': {
      type: 'boolean',
      description: 'When load is failing, show all items rather than only failing items',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @envFlag in the schema if present',
    },
  },
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const { format, 'show-all': showAll } = ctx.values;

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
  });
  checkForSchemaErrors(envGraph);

  // TODO: move into a more general post-load hook system
  if (envGraph.rootDataSource?.decorators.generateTypes) {
    // TODO: much of this logic should move to the definition of the decorator itself
    const typeGenSettings = envGraph.rootDataSource?.decorators.generateTypes.bareFnArgs?.simplifiedValues;
    if (!_.isPlainObject(typeGenSettings)) {
      throw new Error('@generateTypes - must be a fn call with key/value args');
    }
    if (!typeGenSettings.lang) throw new Error('@generateTypes - must set `lang` arg');
    if (typeGenSettings.lang !== 'ts') throw new Error(`@generateTypes - unsupported language: ${typeGenSettings.lang}`);
    if (!typeGenSettings.path) throw new Error('@generateTypes - must set `path` arg');
    if (!_.isString(typeGenSettings.path)) throw new Error('@generateTypes - `path` arg must be a string');
    await envGraph.generateTypes(typeGenSettings.lang, typeGenSettings.path);
  }

  await envGraph.resolveEnvValues();
  checkForConfigErrors(envGraph, { showAll });

  if (format === 'pretty') {
    for (const itemKey in envGraph.configSchema) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (format === 'json') {
    console.log(JSON.stringify(envGraph.getResolvedEnvObject(), null, 2));
  } else if (format === 'json-full') {
    console.log(JSON.stringify(envGraph.getSerializedGraph(), null, 2));
  } else if (format === 'env') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    for (const key in resolvedEnv) {
      const value = resolvedEnv[key];
      let strValue: string;
      if (value === undefined) {
        strValue = '';
      } else if (typeof value === 'string') {
        strValue = `"${value.replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
      } else {
        strValue = JSON.stringify(value);
      }
      console.log(`${key}=${strValue}`);
    }
  } else {
    throw new Error(`Unknown format: ${format}`);
  }

  // const resolvedEnv = envGraph.getResolvedEnvObject();
  // console.log(resolvedEnv);
};
