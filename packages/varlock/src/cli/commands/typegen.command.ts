import { define } from 'gunshi';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'typegen',
  description: 'Generate TypeScript types from your env schema',
  args: {
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the entry point',
    },
  },
  examples: `
Generates TypeScript type definitions from your .env schema files.
Uses only non-environment-specific schema info, so output is deterministic
regardless of which environment is active.

This is useful when you have \`@generateTypes(lang=ts, path=env.d.ts, auto=false)\`
in your schema to disable automatic type generation during \`varlock load\` or \`varlock run\`.

Examples:
  varlock typegen                    # Generate types using default schema
  varlock typegen --path .env.prod   # Generate types from a specific .env file
`.trim(),
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePath: ctx.values.path as string | undefined,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Force type generation even if auto=false is set
  const generatedCount = await envGraph.generateTypesIfNeeded({ ignoreAutoFalse: true });

  if (generatedCount === 0) {
    throw new CliExitError('No @generateTypes decorator found in your schema', {
      suggestion: 'Add `@generateTypes(lang=ts, path=env.d.ts)` to your .env.schema file.',
    });
  }

  console.log('✅ Types generated successfully');
};
