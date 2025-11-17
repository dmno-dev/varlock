import { define } from 'gunshi';
import _ from '@env-spec/utils/my-dash';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import path from 'node:path';
import { FileBasedDataSource } from '../../env-graph';

export const commandSpec = define({
  name: 'load',
  description: 'Load env according to schema and resolve values',
  args: {
    format: {
      type: 'enum',
      short: 'f',
      choices: ['pretty', 'json', 'env', 'json-full', 'json-full-compact'],
      description: 'Format of output',
      default: 'pretty',
    },
    'show-all': {
      type: 'boolean',
      description: 'When load is failing, show all items rather than only failing items',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @currentEnv in the schema if present',
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

  await envGraph.resolveEnvValues();

  // ideally we could be smarter about generating types without needing to resolve values
  // but for now the decorators are all resolved as part of the general resolution process
  const generateTypesDecs = envGraph.getRootDecFns('generateTypes');
  for (const generateTypesDec of generateTypesDecs) {
    const typeGenSettings = await generateTypesDec.resolve();

    if (!typeGenSettings.obj.lang) throw new Error('@generateTypes - must set `lang` arg');
    if (typeGenSettings.obj.lang !== 'ts') throw new Error(`@generateTypes - unsupported language: ${typeGenSettings.obj.lang}`);
    if (!typeGenSettings.obj.path) throw new Error('@generateTypes - must set `path` arg');
    if (!_.isString(typeGenSettings.obj.path)) throw new Error('@generateTypes - `path` arg must be a string');

    const outputPath = generateTypesDec.dataSource instanceof FileBasedDataSource
      ? path.resolve(generateTypesDec.dataSource.fullPath, '..', typeGenSettings.obj.path)
      : typeGenSettings.obj.path;

    await envGraph.generateTypes(typeGenSettings.obj.lang, outputPath);
  }

  checkForConfigErrors(envGraph, { showAll });

  if (format === 'pretty') {
    for (const itemKey in envGraph.configSchema) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (format === 'json') {
    console.log(JSON.stringify(envGraph.getResolvedEnvObject(), null, 2));
  } else if (format === 'json-full' || format === 'json-full-compact') {
    console.log(JSON.stringify(envGraph.getSerializedGraph(), null, format === 'json-full-compact' ? 0 : 2));
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
