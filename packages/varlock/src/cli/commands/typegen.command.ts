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
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
  },
  examples: `
Generates TypeScript type definitions from your .env schema files.
Uses only your schema definitions, so output is deterministic regardless of
which environment is active. Keys that come only from value files like .env or
.env.local are ignored - only items declared in your schema are included.

This is useful when you have \`@generateTypes(lang=ts, path=env.d.ts, auto=false)\`
in your schema to disable automatic type generation during \`varlock load\` or \`varlock run\`.

Examples:
  varlock typegen                    # Generate types using default schema
  varlock typegen --path .env.prod   # Generate types from a specific .env file
`.trim(),
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
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

  // Nudge about keys that only live in a plain `.env` and were left out of the types.
  // Only shown here (the explicit command), not during background auto-generation on load/run.
  const excludedKeys = envGraph.getValueOnlyKeysExcludedFromTypes();
  if (excludedKeys.length) {
    console.log('');
    console.log(`ℹ️  Ignored ${excludedKeys.length} key${excludedKeys.length === 1 ? '' : 's'} found only in .env (not declared in your schema):`);
    console.log(`   ${excludedKeys.join(', ')}`);
    console.log('   Declare them in your .env.schema to include them in generated types.');
  }
};
