import path from 'node:path';
import fs from 'node:fs';

import { FileBasedDataSource } from '../../env-graph';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import * as localEncrypt from '../../lib/local-encrypt';
import { canMigrateToIdentity, migrateFileToIdentity } from '../../lib/local-encrypt/migrate';
import { commandSpec } from './migrate.command-spec';

export { commandSpec };

/** Every env file the graph actually reads from, in load order */
async function getGraphEnvFilePaths(): Promise<Array<string>> {
  const envGraph = await loadVarlockEnvGraph();
  return envGraph.sortedDataSources
    .filter((s): s is FileBasedDataSource => s instanceof FileBasedDataSource)
    .map((s) => s.fullPath)
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const keyId = String(ctx.values['key-id'] || localEncrypt.DEFAULT_KEY_ID);
  const dryRun = Boolean(ctx.values['dry-run']);

  const backend = localEncrypt.getBackendInfo();
  const canMigrate = canMigrateToIdentity();
  if (!canMigrate.ok) {
    console.log(canMigrate.reason);
    console.log('\nNothing was changed.');
    return;
  }

  await localEncrypt.ensureEncryptionReady(keyId);
  console.log(`Using ${backend.type} backend (${backend.hardwareBacked ? 'hardware-backed' : 'file-based'})`);

  let filePaths: Array<string>;
  if (ctx.values.file) {
    const resolvedPath = path.resolve(ctx.values.file);
    if (!fs.existsSync(resolvedPath)) {
      throw new CliExitError(`File not found: ${resolvedPath}`);
    }
    filePaths = [resolvedPath];
  } else {
    filePaths = await getGraphEnvFilePaths();
  }

  let totalMigrated = 0;
  for (const filePath of filePaths) {
    // sequential on purpose: each file rewrite reads and writes the same file

    const result = await migrateFileToIdentity(filePath, { keyId, dryRun });
    if (result.migrated.length === 0) continue;

    totalMigrated += result.migrated.length;
    // a file outside the cwd reads better as its full path than as ../../..
    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`\n${relativePath.startsWith('..') ? filePath : relativePath}`);
    for (const key of result.migrated) {
      console.log(`  ${dryRun ? 'Would migrate' : 'Migrated'}: ${key}`);
    }
    const failed = result.skipped.filter((s) => s.reason === 'write-back-failed');
    for (const skip of failed) {
      console.log(`  Could not update: ${skip.key}`);
    }
  }

  if (totalMigrated === 0) {
    console.log('\nNo device-encrypted values found to migrate.');
    return;
  }

  console.log(
    `\n${dryRun ? 'Would migrate' : 'Migrated'} ${totalMigrated} value${totalMigrated !== 1 ? 's' : ''}`
    + ' to your identity key.',
  );
};
