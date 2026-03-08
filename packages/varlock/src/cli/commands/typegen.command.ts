import { define } from 'gunshi';
import _ from '@env-spec/utils/my-dash';
import path from 'node:path';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { FileBasedDataSource } from '../../env-graph';

export const commandSpec = define({
  name: 'typegen',
  description: 'Regenerate TypeScript type definitions from the schema without validation output',
  args: {
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @currentEnv in the schema if present',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the entry point',
    },
  },
  examples: `
Regenerates .d.ts type definitions from your .env.schema without running validation or producing output.
Useful for editors, TypeScript, and CI when you need type generation separate from validation.

Examples:
  varlock typegen                  # Regenerate types (silent on success)
  varlock typegen --path .env.prod # Use a specific .env file as entry point
  varlock typegen --env production # Use a specific environment (⚠️ ignored if using @currentEnv!)
`.trim(),
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePath: ctx.values.path,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  if (!envGraph.rootDataSource) throw new Error('expected root data source to be set');

  const generateTypesDecs = envGraph.getRootDecFns('generateTypes');
  for (const generateTypesDec of generateTypesDecs) {
    const typeGenSettings = await generateTypesDec.resolve();

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

  // Silently succeed - no validation output per issue #335
};
