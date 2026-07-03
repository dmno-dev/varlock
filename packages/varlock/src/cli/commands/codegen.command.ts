import { define } from 'gunshi';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'codegen',
  description: 'Generate code (types and env modules) from your env schema',
  args: {
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
  },
  examples: `
Generates code from your .env schema files.
Uses only non-environment-specific schema info, so output is deterministic
regardless of which environment is active.

Add a per-language decorator to your schema for each output you want:
  @generateTsTypes(path=env.d.ts)
  @generatePythonEnv(path=env.py)
  @generateRustEnv(path=src/env.rs)
  @generateGoEnv(path=env/env.go)
  @generatePhpEnv(path=Env.php)

This is useful when you have \`auto=false\` set on a generator decorator to
disable automatic generation during \`varlock load\` or \`varlock run\`.

Examples:
  varlock codegen                    # Generate using the default schema
  varlock codegen --path .env.prod   # Generate from a specific .env file
`.trim(),
});


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Force generation even if auto=false is set
  const generatedCount = await envGraph.runCodeGeneratorsIfNeeded({ ignoreAutoFalse: true });

  if (generatedCount === 0) {
    throw new CliExitError('No code-generation decorator found in your schema', {
      suggestion: 'Add `@generateTsTypes(path=env.d.ts)` (or `@generatePythonEnv(path=env.py)`, etc.) to your .env.schema file.',
    });
  }

  console.log('✅ Code generated successfully');

  // Nudge about keys that only live in a plain `.env` and were left out of the generated output.
  // Only shown here (the explicit command), not during background auto-generation on load/run.
  const excludedKeys = envGraph.getValueOnlyKeysExcludedFromTypes();
  if (excludedKeys.length) {
    console.log('');
    console.log(`ℹ️  Ignored ${excludedKeys.length} key${excludedKeys.length === 1 ? '' : 's'} found only in .env (not declared in your schema):`);
    console.log(`   ${excludedKeys.join(', ')}`);
    console.log('   Declare them in your .env.schema to include them in generated output.');
  }
};
