import fs from 'node:fs';
import path from 'node:path';
import ansis from 'ansis';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { encryptEnvBlobSync } from '../../runtime/crypto';
import { USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import { USE_INJECTED_ENV_VAR } from '../../lib/injected-env-reuse';
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
    throw new CliExitError(`_VARLOCK_ENV_KEY is not set, so the frozen env ${ctx.values.out === '-' ? 'payload' : 'file'} cannot be encrypted`, {
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

  // `@dynamic=boot` items are bound at process start on each instance (a platform-assigned
  // PORT, pod identity), so they are left out of the pin entirely: their resolvers never run
  // here, and they are resolved and validated against the schema at boot instead. The graph
  // already guarantees nothing pinned depends on them (see checkBootDynamicDependencies).
  const bootKeys = envGraph.sortedConfigKeys.filter((k) => envGraph.configSchema[k].isBootDynamic);
  const pinnedKeys = envGraph.sortedConfigKeys.filter((k) => !envGraph.configSchema[k].isBootDynamic);

  // Generate types before resolving values: uses only non-env-specific schema info
  await envGraph.runCodeGeneratorsIfNeeded();
  await envGraph.resolveEnvValues(bootKeys.length ? pinnedKeys : undefined);
  // a frozen file is consumed without re-resolution, so a partially-broken graph must never
  // be written - there would be no opportunity to surface the failure later
  checkForConfigErrors(envGraph);
  showPluginWarnings(envGraph);

  // Which environment actually got frozen. `--env` is only a fallback, so a schema using
  // `@currentEnv` ignores it (same as `varlock load --env`) - but here that silently bakes
  // the wrong environment's values into a deploy artifact, which is the exact failure this
  // command exists to prevent. Refuse rather than warn: a frozen file is consumed without
  // re-resolution, so nothing downstream gets another chance to catch it.
  const envFlagKey = envGraph.rootDataSource?.envFlagKey;
  const frozenEnv = envGraph.rootDataSource?.envFlagValue;
  const requestedEnv = ctx.values.env;
  if (requestedEnv && envFlagKey && String(frozenEnv) !== requestedEnv) {
    throw new CliExitError(
      `--env ${requestedEnv} was ignored: this schema sets @currentEnv, so the environment comes from ${envFlagKey} (currently "${frozenEnv}")`,
      {
        suggestion: `Set the value instead, e.g. \`${envFlagKey}=${requestedEnv} varlock freeze\`, and drop --env.`,
      },
    );
  }

  const serialized = envGraph.getSerializedGraph(bootKeys.length ? { filterKeys: new Set(pinnedKeys) } : undefined);
  // marks the payload as a freeze (consumers apply it on top of the schema when it leaves
  // keys to boot) and records what was frozen - see the SerializedEnvGraph type
  serialized.frozen = {
    bootKeys,
    ...(frozenEnv !== undefined ? { currentEnv: String(frozenEnv) } : {}),
  };

  // Override provenance describes process.env overrides at the ORIGINAL invocation, so
  // consumers re-apply exactly those keys from their own environment. That makes sense for a
  // nested `varlock run`, but here it would mean any schema key that happened to be set in
  // CI becomes a key the deployment platform can override at runtime - a hole in the very
  // pin this file exists to create. A frozen file has no parent invocation, so: no overrides.
  serialized.overrideKeys = [];

  const serializedJson = JSON.stringify(serialized);
  const contents = encryptionKey ? encryptEnvBlobSync(serializedJson, encryptionKey) : serializedJson;
  const itemCount = Object.keys(serialized.config).length;

  // every summary names what was left out - a key that is not pinned is the one thing a
  // reader of "Froze N env vars" would otherwise assume is
  const bootSummaryLine = bootKeys.length
    ? ansis.gray(`  left to boot (@dynamic=boot): ${ansis.bold(bootKeys.join(', '))}`)
    : undefined;
  const bootNextStepLines = bootKeys.length ? [
    `${bootKeys.join(', ')} ${bootKeys.length === 1 ? 'is' : 'are'} resolved and validated against the schema at boot, so the runtime`,
    'needs the varlock CLI and your .env.schema alongside the app (boot via `varlock run`, or',
    '`varlock/auto-load` with the CLI installed). Everything else stays pinned.',
  ] : [];

  // `--out -` emits the payload on stdout instead of writing a file, for platforms that
  // accept env vars but give you no way to get a file into the deploy unit (a compose file
  // pulling an image tag it does not rebuild, an ECS task definition, Heroku config vars).
  // Same payload, different transport: capture it into `__VARLOCK_ENV` and set
  // `_VARLOCK_USE_INJECTED_ENV=1` at runtime. The seal is weaker than a file's, because the
  // blob then lives in platform config rather than inside the release, so it does not roll
  // back with the code - but it is still resolved and validated once, as one unit.
  if (String(ctx.values.out) === '-') {
    // the payload owns stdout so `$(varlock freeze --out -)` captures it and nothing else -
    // every human-facing line goes to stderr
    process.stdout.write(`${contents}\n`);
    console.error(`Froze ${itemCount} env var${itemCount === 1 ? '' : 's'} to stdout`);
    if (frozenEnv !== undefined) console.error(ansis.gray(`  environment: ${ansis.bold(String(frozenEnv))}`));
    if (bootSummaryLine) console.error(bootSummaryLine);
    console.error(ansis.gray(`  ${encryptionKey ? 'encrypted with _VARLOCK_ENV_KEY' : 'UNENCRYPTED'}`));
    console.error('');
    if (!encryptionKey) {
      console.error(`${ansis.yellow('⚠')} This payload holds every resolved value in plaintext, including secrets.`);
      console.error(ansis.gray('  Anywhere you put it - a compose file, a task definition, `docker inspect`,'));
      console.error(ansis.gray('  /proc/<pid>/environ - it is readable as-is.'));
      console.error('');
    }
    console.error('Next steps:');
    console.error(ansis.gray('  1. Capture it into __VARLOCK_ENV on your platform, e.g.'));
    console.error(ansis.gray('     export __VARLOCK_ENV=$(varlock freeze --out -)'));
    console.error(ansis.gray(`  2. Set ${USE_INJECTED_ENV_VAR}=1 in the runtime environment, so the blob is`));
    console.error(ansis.gray('     trusted as-is rather than checked against .env files that are not there.'));
    if (encryptionKey) {
      console.error(ansis.gray('  3. Set _VARLOCK_ENV_KEY in the runtime environment so it can be decrypted.'));
      console.error(ansis.gray('  4. Boot your app as usual - `varlock/auto-load` hydrates from the blob.'));
    } else {
      console.error(ansis.gray('  3. Boot your app as usual - `varlock/auto-load` hydrates from the blob.'));
    }
    console.error('');
    for (const line of bootNextStepLines) console.error(ansis.gray(line));
    if (bootNextStepLines.length) console.error('');
    console.error(ansis.gray('Values are now pinned: rotating a secret takes effect on your next deploy, not on restart.'));
    return;
  }

  const outPath = path.resolve(process.cwd(), String(ctx.values.out));

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // 0600 so the resolved values aren't readable by other users on a shared build machine.
    // Written to a fresh temp file and renamed into place: `mode` only applies when a file
    // is created, so writing over an existing (re-frozen) artifact would keep whatever mode
    // it had, and the rename means nothing ever reads a half-written file.
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${contents}\n`, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  } catch (err) {
    throw new CliExitError(`Failed to write frozen env file to ${outPath}: ${(err as Error).message}`);
  }

  const relOutPath = path.relative(process.cwd(), outPath) || outPath;

  console.log(`Froze ${itemCount} env var${itemCount === 1 ? '' : 's'} into ${ansis.bold(relOutPath)}`);
  // always state the environment - this file gets shipped, and picking the wrong one is
  // the easiest mistake to make and the hardest to notice
  if (frozenEnv !== undefined) console.log(ansis.gray(`  environment: ${ansis.bold(String(frozenEnv))}`));
  if (bootSummaryLine) console.log(bootSummaryLine);
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
  for (const line of bootNextStepLines) console.log(ansis.gray(line));
  if (bootNextStepLines.length) console.log('');
  console.log(ansis.gray(`Add ${relOutPath} to your .gitignore - it is a generated artifact holding resolved values.`));
  console.log(ansis.gray('Values are now pinned: rotating a secret takes effect on your next deploy, not on restart.'));
  console.log(ansis.gray(`Set ${USE_FROZEN_ENV_VAR}=1 at runtime to make a missing file a hard error rather than falling back to normal resolution.`));
};
