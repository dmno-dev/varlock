import fs from 'node:fs/promises';
import path from 'node:path';
import ansis from 'ansis';
import { define } from 'gunshi';

import { FileBasedDataSource } from '../../env-graph';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { scanCodeForEnvVars, type EnvVarReference } from '../helpers/env-var-scanner';
import { gracefulExit } from 'exit-hook';
import { diffSchemaAndCodeKeys } from '../helpers/audit-diff';

export const commandSpec = define({
  name: 'audit',
  description: 'Audit code env var usage against your .env.schema',
  args: {
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the schema entry point',
    },
  },
  examples: `
Scans your source code for environment variable references and compares them
to keys defined in your varlock schema.

Examples:
  varlock audit                    # Audit current project
  varlock audit --path .env.prod   # Audit using a specific env entry point
`.trim(),
});

function formatReference(cwd: string, ref: EnvVarReference): string {
  const relPath = path.relative(cwd, ref.filePath);
  return `${relPath}:${ref.lineNumber}:${ref.columnNumber}`;
}

async function getScanRootFromEntryPath(providedEntryPath: string): Promise<string> {
  const resolved = path.resolve(providedEntryPath);
  try {
    const entryStat = await fs.stat(resolved);
    if (entryStat.isDirectory()) return resolved;
  } catch {
    // loadVarlockEnvGraph validates path before this point; fallback keeps behavior predictable
  }

  if (providedEntryPath.endsWith('/') || providedEntryPath.endsWith(path.sep)) {
    return resolved;
  }
  return path.dirname(resolved);
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const providedEntryPath = ctx.values.path as string | undefined;
  const envGraph = await loadVarlockEnvGraph({
    entryFilePath: providedEntryPath,
  });

  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  const schemaScanRoot = (() => {
    if (providedEntryPath) {
      return undefined;
    }

    const rootSource = envGraph.rootDataSource;
    if (rootSource instanceof FileBasedDataSource) {
      return path.dirname(rootSource.fullPath);
    }
    return envGraph.basePath ?? process.cwd();
  })();

  const finalScanRoot = providedEntryPath
    ? await getScanRootFromEntryPath(providedEntryPath)
    : (schemaScanRoot ?? process.cwd());

  const scanResult = await scanCodeForEnvVars({ cwd: finalScanRoot });
  const schemaKeys = Object.keys(envGraph.configSchema);

  const diff = diffSchemaAndCodeKeys(schemaKeys, scanResult.keys);

  if (diff.missingInSchema.length === 0 && diff.unusedInSchema.length === 0) {
    console.log(ansis.green(`✅ Schema and code references are in sync. (scanned ${scanResult.scannedFilesCount} file${scanResult.scannedFilesCount === 1 ? '' : 's'})`));
    gracefulExit(0);
    return;
  }

  console.error(ansis.red('\n🚨 Schema/code mismatch detected:\n'));

  if (diff.missingInSchema.length > 0) {
    console.error(ansis.red(`Missing in schema (${diff.missingInSchema.length}):`));
    for (const key of diff.missingInSchema) {
      const refs = scanResult.references.filter((r) => r.key === key).slice(0, 3);
      const refPreview = refs.map((r) => formatReference(finalScanRoot, r)).join(', ');
      console.error(`  - ${ansis.bold(key)}${refPreview ? ansis.dim(` (seen at ${refPreview})`) : ''}`);
    }
    console.error('');
  }

  if (diff.unusedInSchema.length > 0) {
    console.error(ansis.yellow(`Unused in schema (${diff.unusedInSchema.length}):`));
    for (const key of diff.unusedInSchema) {
      console.error(`  - ${ansis.bold(key)}`);
    }
    console.error('');
  }

  gracefulExit(1);
};
