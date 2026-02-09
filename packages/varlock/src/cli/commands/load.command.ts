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
    compact: {
      type: 'boolean',
      description: 'Use compact format (for json-full: no indentation, for env: skip undefined values)',
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
  examples: `
Loads and validates environment variables according to your .env files, and prints the results.
Useful for debugging locally, and in CI to print out a summary of env vars.

Examples:
  varlock load                    # Load and validate with pretty output
  varlock load --env production   # Load for a specific environment
  varlock load --format json      # Output in JSON format
  varlock load --show-all         # Show all items when validation fails

⚠️ Note: Setting @currentEnv in your .env.schema will override the --env flag
  `.trim(),
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const { format, compact, 'show-all': showAll } = ctx.values;

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

    // we skip generating types if `@generateTypes` was not in the main file
    // unless the `executeWhenImported` flag is set
    if (generateTypesDec.dataSource.isImport && !typeGenSettings.obj.executeWhenImported) continue;

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
    for (const itemKey of envGraph.sortedConfigKeys) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (format === 'json') {
    console.log(JSON.stringify(envGraph.getResolvedEnvObject(), null, 2));
  } else if (format === 'json-full' || format === 'json-full-compact') {
    const indent = format === 'json-full-compact' || compact ? 0 : 2;
    console.log(JSON.stringify(envGraph.getSerializedGraph(), null, indent));
  } else if (format === 'env') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    const skipUndefined = compact === true;

    for (const key in resolvedEnv) {
      const value = resolvedEnv[key];

      if (value === undefined && skipUndefined) {
        continue;
      }

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
