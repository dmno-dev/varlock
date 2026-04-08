import fs from 'node:fs/promises';
import path from 'node:path';
import ansis from 'ansis';
import { define } from 'gunshi';

import { FileBasedDataSource } from '../../env-graph';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import {
  scanCodeForEnvVars,
  type EnvVarReference,
} from '../helpers/env-var-scanner';
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

function collectStringArgs(input: unknown, out: Array<string>) {
  if (Array.isArray(input)) {
    for (const entry of input) collectStringArgs(entry, out);
    return;
  }
  if (typeof input !== 'string') return;

  const normalized = input.trim().replace(/^\.\//, '').replace(/[/\\]+$/, '');
  if (!normalized) return;
  out.push(normalized);
}

async function getCustomAuditIgnorePaths(envGraph: any): Promise<Array<string>> {
  const rootDecFns = typeof envGraph?.getRootDecFns === 'function'
    ? envGraph.getRootDecFns('auditIgnorePaths')
    : [];

  const mergedPaths: Array<string> = [];
  for (const dec of rootDecFns || []) {
    const resolved = await dec.resolve();
    collectStringArgs(resolved?.arr, mergedPaths);
  }

  return [...new Set(mergedPaths)];
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

  const customIgnoredPaths = await getCustomAuditIgnorePaths(envGraph);
  if (customIgnoredPaths.length > 0) {
    console.log(`ℹ️ Skipping custom ignored paths: ${customIgnoredPaths.join(', ')}`);
  }

  const scanResult = await scanCodeForEnvVars(
    { cwd: finalScanRoot },
    customIgnoredPaths,
  );
  const schemaKeys = Object.keys(envGraph.configSchema);

  const diff = diffSchemaAndCodeKeys(schemaKeys, scanResult.keys);
  const unusedInSchema: Array<string> = [];
  for (const key of diff.unusedInSchema) {
    const item = envGraph.configSchema[key];
    const itemDecorators = (item as any)?.decorators as Record<string, unknown> | undefined;
    const isIgnored = (typeof item?.getDec === 'function' && (item.getDec('auditIgnore') as unknown) === true)
      || (itemDecorators?.auditIgnore === true);
    if (isIgnored) continue;
    unusedInSchema.push(key);
  }

  if (diff.missingInSchema.length === 0 && unusedInSchema.length === 0) {
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

  if (unusedInSchema.length > 0) {
    console.error(ansis.yellow(`Unused in schema (${unusedInSchema.length}):`));
    for (const key of unusedInSchema) {
      console.error(`  - ${ansis.bold(key)}`);
    }
    console.error(ansis.dim('(Hint: If this is used by an external tool, add # @auditIgnore to the item)'));
    console.error('');
  }

  gracefulExit(1);
};
