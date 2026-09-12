import fs from 'node:fs/promises';
import path from 'node:path';
import ansis from 'ansis';

import { FileBasedDataSource } from '../../env-graph';
import { CliExitError } from '../helpers/exit-error';
import { parseRegexLikeString } from '../../env-graph/lib/resolver';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import {
  DEFAULT_IGNORED_DIRS,
  isDirExcluded,
  normalizeDirExclusions,
  scanCodeForEnvVars,
  type EnvVarReference,
  type ExtraScanPattern,
  type ScanCodeEnvVarsResult,
} from '../helpers/env-var-scanner';
import { gracefulExit } from 'exit-hook';
import { diffSchemaAndCodeKeys } from '../helpers/audit-diff';
import { isWellKnownEnvKey } from '../helpers/well-known-env-keys';
import { commandSpec } from './audit.command-spec';

export { commandSpec };

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

/**
 * Flatten decorator args (which may be nested array literals) into trimmed strings.
 * Entries are passed through verbatim otherwise: ignore-path entries carry meaning in
 * their leading `./` and separators, and the scanner owns that normalization so the
 * decorator and `--ignore` can't interpret them differently.
 */
function collectStringArgs(input: unknown, out: Array<string>) {
  if (Array.isArray(input)) {
    for (const entry of input) collectStringArgs(entry, out);
    return;
  }
  if (typeof input !== 'string') return;

  const trimmed = input.trim();
  if (!trimmed) return;
  out.push(trimmed);
}

function collectPatternArgs(input: unknown, out: Array<RegExp>) {
  if (Array.isArray(input)) {
    for (const entry of input) collectPatternArgs(entry, out);
    return;
  }
  // `regex('...')` calls already resolve to RegExp instances. Quoted
  // '/.../flags' strings convert via the same rule the DSL uses everywhere;
  // anything else (bare words, numbers) is a config error, not a pattern.
  // Note: a bare unquoted literal only survives parsing when it contains no
  // spaces, commas or parens, so realistic patterns must be quoted or use
  // regex('...'); both forms land here, never raw.
  if (input instanceof RegExp) {
    out.push(input);
    return;
  }
  if (typeof input === 'string') {
    const parsed = parseRegexLikeString(input);
    if (parsed) {
      out.push(parsed);
      return;
    }
  }
  // Uses CliExitError rather than a graph error type: this runs after the graph has
  // loaded, and the CLI's top-level handler only formats CliExitError/InvalidEnvError -
  // anything else surfaces as an unhandled stack trace.
  throw new CliExitError(
    "@auditExtraPatterns() expects regex patterns - regex() calls or quoted '/.../' literals",
    {
      details: 'The first capture group of each pattern is the env key.',
      suggestion: "e.g. # @auditExtraPatterns(regex('config\\.get\\(\\s*\\'([A-Z_]+)\\''))",
    },
  );
}

/**
 * Read the `fileTypes=[...]` option off one `@auditExtraPatterns(...)` call. Each call
 * is its own scope unit: the file types apply to the patterns in that call only.
 */
function collectFileTypesArg(objArgs: unknown): Array<string> | undefined {
  const record = (objArgs ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'fileTypes') {
      throw new CliExitError(`@auditExtraPatterns(): unknown option "${key}"`, {
        suggestion: 'The only option is fileTypes=[...], a list of file extensions the patterns in this call apply to.',
      });
    }
  }
  if (!('fileTypes' in record)) return undefined;

  const fileTypes: Array<string> = [];
  collectStringArgs(record.fileTypes, fileTypes);
  if (!fileTypes.length) {
    throw new CliExitError('@auditExtraPatterns(): fileTypes=[...] cannot be empty', {
      suggestion: 'List the file types the patterns apply to, e.g. fileTypes=[tf, yaml], or drop the option to match every scanned file.',
    });
  }
  return fileTypes;
}

async function getCustomAuditExtraPatterns(envGraph: any): Promise<Array<ExtraScanPattern>> {
  const rootDecFns = typeof envGraph?.getRootDecFns === 'function'
    ? envGraph.getRootDecFns('auditExtraPatterns')
    : [];

  const scanPatterns: Array<ExtraScanPattern> = [];
  for (const dec of rootDecFns || []) {
    const resolved = await dec.resolve();
    const fileTypes = collectFileTypesArg(resolved?.obj);
    const patterns: Array<RegExp> = [];
    collectPatternArgs(resolved?.arr, patterns);
    if (!patterns.length && fileTypes) {
      throw new CliExitError('@auditExtraPatterns(): fileTypes=[...] given with no patterns to apply it to', {
        suggestion: 'Add at least one regex() pattern to this call.',
      });
    }
    for (const pattern of patterns) scanPatterns.push({ pattern, ...(fileTypes ? { fileTypes } : {}) });
  }
  return scanPatterns;
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
  // A path-shaped entry must say so, rather than the rule being inferred from whether a
  // separator happens to be present. Both failure modes below could only ever match
  // nothing, so they're reported instead of silently doing so.
  const exclusions = await normalizeDirExclusions(allIgnoredPaths, finalScanRoot);
  const {
    names: ignoredNames, absolute: ignoredAbsolutePaths, unrooted, outside, notDirectories,
  } = exclusions;
  if (unrooted.length > 0) {
    const [first] = unrooted;
    throw new CliExitError(
      `Ignored path "${first}" must start with "./" to be treated as a path`,
      {
        details: 'Without it, an entry is a directory name matched wherever it appears, and a name can never contain a separator.',
        suggestion: `Write "./${first}" for that directory specifically, or name a single directory to skip it everywhere.`,
      },
    );
  }
  if (outside.length > 0) {
    const [first] = outside;
    throw new CliExitError(
      `Ignored path "${first}" is outside the scanned directory`,
      {
        details: `Nothing under ${finalScanRoot} matches it, so it would exclude nothing.`,
        suggestion: 'Point it inside the scanned tree, or name a single directory to skip it wherever it appears.',
      },
    );
  }
  if (notDirectories.length > 0) {
    const [first] = notDirectories;
    throw new CliExitError(
      `Ignored path "${first}" is not a directory`,
      {
        details: 'Exclusions prune directories from the scan, so a file would exclude nothing.',
        suggestion: `Name the directory that contains it, or use @auditIgnore on the schema items only referenced from "${first}".`,
      },
    );
  }
  if (allIgnoredPaths.length > 0) {
    console.log(`ℹ️ Skipping ignored paths: ${allIgnoredPaths.join(', ')}`);
  }

  // Project-supplied escape-hatch patterns from # @auditExtraPatterns(...), each
  // carrying the optional fileTypes=[...] scope from its own call. Only forwarded when
  // configured, so the default scanner call shape - and its tests - stay untouched.
  const customExtraPatterns = await getCustomAuditExtraPatterns(envGraph);
  const extraScanOptions = customExtraPatterns.length > 0
    ? { extraPatterns: customExtraPatterns }
    : {};

  // Path entries are forwarded as absolute paths: with positional targets each scan uses
  // a different cwd, and a `./`-relative entry re-resolved against each one would point
  // somewhere else every time.
  const forwardedIgnores = [...ignoredNames, ...ignoredAbsolutePaths];

  // Asking to scan a directory that is excluded is contradictory. Scanning it anyway
  // reintroduces exactly the noise the exclusion exists to prevent, and scanning nothing
  // would just report zero files with no reason given. The always-skipped defaults count
  // too, so `varlock audit ./node_modules` says why instead of quietly scanning it.
  const defaultExclusions = await normalizeDirExclusions(DEFAULT_IGNORED_DIRS, finalScanRoot);
  for (const target of scanTargets) {
    const relativeTarget = path.relative(finalScanRoot, path.resolve(finalScanRoot, target))
      .split(path.sep).join('/');
    if (isDirExcluded(relativeTarget, exclusions)) {
      throw new CliExitError(`Scan target "${target}" is excluded from the audit scan`, {
        details: 'An @auditIgnorePaths() entry, or --ignore, covers this directory.',
        suggestion: 'Scan a different directory, or drop the exclusion that covers it.',
      });
    }
    if (isDirExcluded(relativeTarget, defaultExclusions)) {
      throw new CliExitError(`Scan target "${target}" is never scanned`, {
        details: `These directories are always skipped: ${DEFAULT_IGNORED_DIRS.join(', ')}.`,
        suggestion: 'Scan a directory that holds your own source code.',
      });
    }
  }

  // If positional scan targets are provided, scan each one individually and merge results
  let scanResult: ScanCodeEnvVarsResult;
  if (scanTargets.length > 0) {
    const mergedRefs: Array<EnvVarReference> = [];
    let totalFilesScanned = 0;
    for (const target of scanTargets) {
      const resolvedTarget = path.resolve(finalScanRoot, target);
      const result = await scanCodeForEnvVars(
        { cwd: resolvedTarget, ...extraScanOptions },
        forwardedIgnores,
      );
      mergedRefs.push(...result.references);
      totalFilesScanned += result.scannedFilesCount;
    }
    const uniqueKeys = [...new Set(mergedRefs.map((r) => r.key))].sort((a, b) => a.localeCompare(b));
    scanResult = { keys: uniqueKeys, references: mergedRefs, scannedFilesCount: totalFilesScanned };
  } else {
    scanResult = await scanCodeForEnvVars(
      { cwd: finalScanRoot, ...extraScanOptions },
      forwardedIgnores,
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
