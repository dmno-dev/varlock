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
  type ScanCodeEnvVarsResult,
} from '../helpers/env-var-scanner';
import { gracefulExit } from 'exit-hook';
import { diffSchemaAndCodeKeys } from '../helpers/audit-diff';
import { isWellKnownEnvKey } from '../helpers/well-known-env-keys';

export const commandSpec = define({
  name: 'audit',
  description: 'Audit code env var usage against your .env.schema',
  args: {
    targets: {
      type: 'positional',
      required: false,
      multiple: true,
      description: 'Directories to scan for env var references (defaults to the current project)',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the schema entry point',
    },
    ignore: {
      type: 'string',
      short: 'i',
      multiple: true,
      description: 'Directory to exclude from code scanning (can be specified multiple times)',
    },
  },
  examples: `
Scans your source code for environment variable references and compares them
to keys defined in your varlock schema.

Examples:
  varlock audit                          # Audit current project
  varlock audit --path .env.prod         # Audit using a specific env entry point
  varlock audit ./src ./lib              # Only scan specific directories
  varlock audit --ignore vendor          # Exclude a directory from scanning
  varlock audit -i vendor -i generated   # Exclude multiple directories
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

/** Collect all config keys that are depended on by other items or root decorators */
function getInternallyReferencedKeys(envGraph: any): Set<string> {
  const referenced = new Set<string>();

  // Keys referenced by other config items (via $REF, concat, fallback, etc.)
  const adjList = envGraph.graphAdjacencyList;
  if (adjList) {
    for (const itemKey in adjList) {
      for (const dep of adjList[itemKey]) {
        referenced.add(dep);
      }
    }
  }

  // Keys referenced by root decorators (e.g., @currentEnv=$APP_ENV)
  for (const source of envGraph.sortedDataSources ?? []) {
    for (const dec of source.rootDecorators ?? []) {
      for (const dep of dec.decValueResolver?.deps ?? []) {
        referenced.add(dep);
      }
    }
  }

  return referenced;
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
  const cliIgnoreDirs = (ctx.values.ignore ?? []) as Array<string>;
  const scanTargets = ctx.values.targets ?? [];

  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: providedEntryPath ? [providedEntryPath] : undefined,
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
  // Merge CLI --ignore dirs with schema @auditIgnorePaths
  const allIgnoredPaths = [...customIgnoredPaths, ...cliIgnoreDirs];
  if (allIgnoredPaths.length > 0) {
    console.log(`ℹ️ Skipping ignored paths: ${allIgnoredPaths.join(', ')}`);
  }

  // If positional scan targets are provided, scan each one individually and merge results
  let scanResult: ScanCodeEnvVarsResult;
  if (scanTargets.length > 0) {
    const mergedRefs: Array<EnvVarReference> = [];
    let totalFilesScanned = 0;
    for (const target of scanTargets) {
      const resolvedTarget = path.resolve(finalScanRoot, target);
      const result = await scanCodeForEnvVars(
        { cwd: resolvedTarget },
        allIgnoredPaths,
      );
      mergedRefs.push(...result.references);
      totalFilesScanned += result.scannedFilesCount;
    }
    const uniqueKeys = [...new Set(mergedRefs.map((r) => r.key))].sort((a, b) => a.localeCompare(b));
    scanResult = { keys: uniqueKeys, references: mergedRefs, scannedFilesCount: totalFilesScanned };
  } else {
    scanResult = await scanCodeForEnvVars(
      { cwd: finalScanRoot },
      allIgnoredPaths,
    );
  }
  const schemaKeys = Object.keys(envGraph.configSchema);

  const diff = diffSchemaAndCodeKeys(schemaKeys, scanResult.keys);
  // Don't report execution-environment plumbing (PATH, NODE_OPTIONS, npm_*, ...) as
  // missing - it's read from process.env in real code but never declared in a schema.
  const missingInSchema = diff.missingInSchema.filter((key) => !isWellKnownEnvKey(key));
  const internallyReferenced = getInternallyReferencedKeys(envGraph);
  const unusedInSchema: Array<string> = [];
  for (const key of diff.unusedInSchema) {
    // Skip keys that are referenced internally by other items or root decorators
    if (internallyReferenced.has(key)) continue;

    const item = envGraph.configSchema[key];
    const auditIgnoreDec = typeof item?.getDec === 'function'
      ? item.getDec('auditIgnore')
      : undefined;
    const isIgnored = auditIgnoreDec?.parsedDecorator.simplifiedValue === true;
    if (isIgnored) continue;
    unusedInSchema.push(key);
  }

  if (missingInSchema.length === 0 && unusedInSchema.length === 0) {
    console.log(ansis.green(`✅ Schema and code references are in sync. (scanned ${scanResult.scannedFilesCount} file${scanResult.scannedFilesCount === 1 ? '' : 's'})`));
    gracefulExit(0);
    return;
  }

  console.error(ansis.red('\n🚨 Schema/code mismatch detected:\n'));

  if (missingInSchema.length > 0) {
    console.error(ansis.red(`Missing in schema (${missingInSchema.length}):`));
    for (const key of missingInSchema) {
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
