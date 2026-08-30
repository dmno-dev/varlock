import fs from 'node:fs';
import path from 'node:path';
import ansis from 'ansis';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { encryptEnvBlobSync } from '../../runtime/crypto';
import { USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import {
  checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors, showPluginWarnings,
} from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { commandSpec } from './freeze.command-spec';

export { commandSpec };

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const allowPlaintext = !!ctx.values['allow-plaintext'];
  const encryptionKey = process.env._VARLOCK_ENV_KEY;

  // Check the key before doing any resolution work - a missing key is a setup problem, and
  // failing fast avoids hitting every resolver (and any biometric/OAuth prompts) first.
  if (!encryptionKey && !allowPlaintext) {
    throw new CliExitError('_VARLOCK_ENV_KEY is not set, so the frozen env file cannot be encrypted', {
      suggestion: 'Generate one with `varlock generate-key`, then set it both here and on your deployment platform '
        + '(the same key must be present at runtime to decrypt). Use --allow-plaintext only if you accept every '
        + 'resolved secret sitting unencrypted inside your deploy artifact.',
    });
  }

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePaths: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
  });
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Generate types before resolving values: uses only non-env-specific schema info
  await envGraph.runCodeGeneratorsIfNeeded();
  await envGraph.resolveEnvValues();
  // a frozen file is consumed without re-resolution, so a partially-broken graph must never
  // be written - there would be no opportunity to surface the failure later
  checkForConfigErrors(envGraph);
  showPluginWarnings(envGraph);

  const serialized = envGraph.getSerializedGraph();

  // Override provenance describes process.env overrides at the ORIGINAL invocation, so
  // consumers re-apply exactly those keys from their own environment. That makes sense for a
  // nested `varlock run`, but here it would mean any schema key that happened to be set in
  // CI becomes a key the deployment platform can override at runtime - a hole in the very
  // pin this file exists to create. A frozen file has no parent invocation, so: no overrides.
  serialized.overrideKeys = [];

  const outPath = path.resolve(process.cwd(), String(ctx.values.out));
  const serializedJson = JSON.stringify(serialized);
  const contents = encryptionKey ? encryptEnvBlobSync(serializedJson, encryptionKey) : serializedJson;

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // 0600 so the resolved values aren't readable by other users on a shared build machine
    fs.writeFileSync(outPath, `${contents}\n`, { mode: 0o600 });
  } catch (err) {
    throw new CliExitError(`Failed to write frozen env file to ${outPath}: ${(err as Error).message}`);
  }

  const itemCount = Object.keys(serialized.config).length;
  const relOutPath = path.relative(process.cwd(), outPath) || outPath;

  console.log(`Froze ${itemCount} env var${itemCount === 1 ? '' : 's'} into ${ansis.bold(relOutPath)}`);
  console.log(ansis.gray(`  ${encryptionKey ? 'encrypted with _VARLOCK_ENV_KEY' : 'UNENCRYPTED'}`));
  console.log('');

  if (!encryptionKey) {
    console.log(`${ansis.yellow('⚠')} This file holds every resolved value in plaintext, including secrets.`);
    console.log(ansis.gray('  Anyone who can read your image layers, registry, or CI artifacts can read them.'));
    console.log('');
  }

  console.log('Next steps:');
  console.log(ansis.gray(`  1. Ship ${relOutPath} inside your deploy artifact (it must be present at boot).`));
  if (encryptionKey) {
    console.log(ansis.gray('  2. Set _VARLOCK_ENV_KEY in the runtime environment so it can be decrypted.'));
    console.log(ansis.gray('  3. Boot your app as usual - varlock picks the file up automatically.'));
  } else {
    console.log(ansis.gray('  2. Boot your app as usual - varlock picks the file up automatically.'));
  }
  console.log('');
  console.log(ansis.gray(`Add ${relOutPath} to your .gitignore - it is a generated artifact holding resolved values.`));
  console.log(ansis.gray('Values are now pinned: rotating a secret takes effect on your next deploy, not on restart.'));
  console.log(ansis.gray(`Set ${USE_FROZEN_ENV_VAR}=1 at runtime to make a missing file a hard error rather than falling back to normal resolution.`));
};
