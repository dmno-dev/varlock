
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './codegen.command-spec';

export { commandSpec };


export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Force generation even if auto=false is set
  const { generatedCount, skippedImportOnlyCount } = await envGraph.runCodeGeneratorsIfNeeded({
    ignoreAutoFalse: true,
  });

  if (generatedCount === 0) {
    // decorators may exist but only in @import-ed files — that's a different fix than "add one"
    if (skippedImportOnlyCount > 0) {
      throw new CliExitError('Code-generation decorators were found only in imported files, which are skipped by default', {
        suggestion: 'Add `executeWhenImported=true` to the decorator in the imported file, or add a decorator to this schema directly.',
      });
    }
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
