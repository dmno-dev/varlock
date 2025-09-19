import { define } from 'gunshi';
import _ from '@env-spec/utils/my-dash';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import path from 'node:path';
import { FileBasedDataSource } from '../../../env-graph';

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

  if (!envGraph.rootDataSource) throw new Error('expected root data source to be set');
  // TODO: move into a more general post-load hook system
  const generateTypesDecoratorsPerSource = envGraph.getRootDecorators('generateTypes');
  if (generateTypesDecoratorsPerSource.length) {
    for (const [source, generateTypesDecorators] of generateTypesDecoratorsPerSource) {
      for (const generateTypesDecorator of generateTypesDecorators) {
        // TODO: much of this logic should move to the definition of the decorator itself
        const typeGenSettings = generateTypesDecorator.bareFnArgs?.simplifiedValues;
        if (!_.isPlainObject(typeGenSettings)) {
          throw new Error('@generateTypes - must be a fn call with key/value args');
        }
        if (!typeGenSettings.lang) throw new Error('@generateTypes - must set `lang` arg');
        if (typeGenSettings.lang !== 'ts') throw new Error(`@generateTypes - unsupported language: ${typeGenSettings.lang}`);
        if (!typeGenSettings.path) throw new Error('@generateTypes - must set `path` arg');
        if (!_.isString(typeGenSettings.path)) throw new Error('@generateTypes - `path` arg must be a string');

        const outputPath = source instanceof FileBasedDataSource
          ? path.resolve(source.fullPath, '..', typeGenSettings.path)
          : typeGenSettings.path;

        await envGraph.generateTypes(typeGenSettings.lang, outputPath);
      }
    }
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
