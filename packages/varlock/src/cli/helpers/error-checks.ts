import ansis from 'ansis';
import { EnvGraph, FileBasedDataSource } from '../../env-graph';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import {
  LoadingError, ParseError, VarlockError, SENSITIVE_NUMBER_NOT_REDACTED,
} from '../../env-graph/lib/errors';
import { isEmptyConfigAllowed } from '../../lib/empty-config-check';
import { CliExitError } from './exit-error';
import { InvalidEnvError } from './invalid-env-error';

export { InvalidEnvError };

function showErrorLocationDetails(err: VarlockError) {
  if (!err.location) return;
  const errLoc = err.location;
  const errPreview = [
    errLoc.lineStr,
    `${ansis.gray('-'.repeat(errLoc.colNumber - 1))}${ansis.red('^')}`,
  ].join('\n');

  console.error('');
  console.error(`📂 ${errLoc.id}:${errLoc.lineNumber}:${errLoc.colNumber}`);
  console.error(errPreview);
}

function showErrorTip(err: VarlockError) {
  if (!err.tip) return;
  for (const line of err.tip.split('\n')) {
    console.error(`  ${line}`);
  }
}

/**
 * Errors when no config items were loaded (no .env files found, or none define items).
 * `allowOptOut` lets `_VARLOCK_ALLOW_EMPTY_CONFIG` skip the check; only `load` and `run` pass it, so
 * commands that need config items (e.g. `proxy`, which would otherwise start with no rules) always fail.
 */
export function checkForNoEnvFiles(envGraph: EnvGraph, opts?: { noThrow?: boolean, allowOptOut?: boolean }) {
  if (Object.keys(envGraph.configSchema).length === 0) {
    // If a source has a parse error, the schema couldn't be read at all so
    // "no config items defined" is misleading — the parse error (already
    // reported by checkForSchemaErrors) is the real problem.
    const hasParseErrors = envGraph.sortedDataSources.some((s) => s.loadingError instanceof ParseError);
    if (hasParseErrors) {
      if (opts?.noThrow) return;
      throw new CliExitError('Parse error', { silent: true });
    }

    // explicit opt-in to running with an empty config (e.g. a deploy that ships no .env files)
    if (opts?.allowOptOut && isEmptyConfigAllowed()) return;

    const displayPath = envGraph.basePath ?? process.cwd();
    const hasLoadedFiles = envGraph.sortedDataSources.some((s) => s instanceof FileBasedDataSource);
    if (!hasLoadedFiles) {
      console.error(`🚨 No .env files found in ${displayPath}\n`);
      console.error('Run `varlock init` to create a .env.schema file, or use `--path` to specify a file or directory.');
    } else {
      console.error(`🚨 No config items defined in ${displayPath}\n`);
      console.error('Add items to your .env.schema file to get started.');
    }
    if (opts?.noThrow) return;
    throw new CliExitError('No env files', { silent: true });
  }
}

export function checkForSchemaErrors(envGraph: EnvGraph, opts?: { noThrow?: boolean }) {
  let hasErrors = false;
  let hasOutput = false;
  for (const source of envGraph.sortedDataSources) {
    // `source.errors` is an aggregate view that already overlaps with `resolutionErrors`, so
    // sort every unique error into exactly one bucket - each error is printed once, by construction
    const resolutionErrorSet = new Set(source.resolutionErrors);
    const warnings: Array<VarlockError> = [];
    const loadingErrors: Array<VarlockError> = [];
    const otherErrors: Array<VarlockError> = [];
    const resolutionErrors: Array<VarlockError> = [];
    for (const err of new Set([...source.errors, ...resolutionErrorSet])) {
      if (resolutionErrorSet.has(err)) resolutionErrors.push(err);
      else if (err.isWarning) warnings.push(err);
      else if (err instanceof LoadingError || err instanceof ParseError) loadingErrors.push(err);
      else otherErrors.push(err);
    }

    if (!warnings.length && !loadingErrors.length && !otherErrors.length && !resolutionErrors.length) continue;
    hasOutput = true;

    // single header per file
    const hasAnyError = loadingErrors.length || otherErrors.length || resolutionErrors.length;
    console.error(ansis.bold[hasAnyError ? 'red' : 'yellow'](`-- Problems encountered in ${source.label} --`));

    if (source instanceof FileBasedDataSource) {
      console.error('📁', ansis.dim(`${source.fullPath}`));
      console.log('');
    }

    for (const warning of warnings) {
      console.error(ansis.yellow(`- ⚠️  ${warning.message}`));
      showErrorLocationDetails(warning);
    }

    for (const err of loadingErrors) {
      console.error(ansis.red(`- ❌ ${err.message}`));
      showErrorTip(err);
      showErrorLocationDetails(err);
      if (err.isUnexpected && err.originalError?.stack) {
        console.error(`\n${ansis.dim('Stack trace:')}`);
        console.error(ansis.dim(err.originalError.stack));
      }
    }

    for (const err of otherErrors) {
      console.error(ansis.red(`- ❌ ${err.message}`));
      showErrorTip(err);
      showErrorLocationDetails(err);
    }

    // surface errors from decorator execute() (e.g., invalid plugin options like cacheTtl).
    // these are fatal and must halt before resolution so downstream resolvers don't
    // run against a half-initialized plugin.
    if (resolutionErrors.length) {
      console.error(ansis.red(`🚨 Error(s) during initialization of ${source.label}`));
      for (const resErr of resolutionErrors) {
        console.error(ansis.red(`- ❌ ${resErr.message}`));
        showErrorTip(resErr);
        showErrorLocationDetails(resErr);
      }
    }

    if (hasAnyError) {
      hasErrors = true;
      if (!opts?.noThrow) throw new CliExitError('Schema error', { silent: true });
    }
  }
  return { hasErrors, hasOutput };
}


export function showPluginWarnings(envGraph: EnvGraph) {
  for (const plugin of envGraph.plugins) {
    if (!plugin.warnings.length) continue;
    for (const warning of plugin.warnings) {
      console.error(ansis.yellow(`[WARNING] ${warning.message}`));
      if (warning.tip) {
        for (const line of warning.tip.split('\n')) {
          console.error(`  ${line}`);
        }
      }
    }
  }
}

/**
 * `varlock load` shows every item warning in its summary, but `varlock run` prints no summary.
 * Surface the one warning that matters for its output: a sensitive number that the child's
 * output redaction will never mask.
 */
export function showUnredactableSensitiveWarnings(envGraph: EnvGraph, itemKeys: Array<string>) {
  for (const itemKey of itemKeys) {
    const item = envGraph.configSchema[itemKey];
    const warning = item?.errors.find((err) => err.isWarning && err.code === SENSITIVE_NUMBER_NOT_REDACTED);
    if (!warning) continue;
    console.error(ansis.yellow(`[WARNING] ${itemKey} - ${warning.message}`));
    showErrorTip(warning);
  }
}

export function checkForConfigErrors(envGraph: EnvGraph, opts?: {
  showAll?: boolean;
  /** Log errors to stderr but don't throw — used when the caller will handle errors itself (e.g. json-full output) */
  noThrow?: boolean;
}) {
  // check for root decorator execution errors (fatal — stop before showing items)
  let hasRootDecoratorErrors = false;
  for (const source of envGraph.sortedDataSources) {
    const resErrors = source.resolutionErrors;
    if (resErrors.length) {
      hasRootDecoratorErrors = true;
      console.error(`🚨 Root decorator error(s) in ${source.label}`);
      if (source instanceof FileBasedDataSource) {
        console.error(ansis.dim(`   ${source.fullPath}`));
      }

      for (const err of resErrors) {
        console.error(ansis.red(`  - ❌ ${err.message}`));
        showErrorTip(err);
        showErrorLocationDetails(err);
      }
    }
  }

  if (hasRootDecoratorErrors) {
    if (!opts?.noThrow) throw new CliExitError('Schema error', { silent: true });
    return;
  }

  const failingItems = envGraph.sortedConfigKeys
    .map((k) => envGraph.configSchema[k])
    .filter((item) => item.validationState === 'error');
  const warningItems = envGraph.sortedConfigKeys
    .map((k) => envGraph.configSchema[k])
    .filter((item) => item.validationState === 'warn');

  if (failingItems.length > 0) {
    console.error(`\n🚨🚨🚨  ${ansis.bold.red.underline('Configuration is currently invalid')}  🚨🚨🚨\n`);

    for (const item of failingItems) {
      console.error(getItemSummary(item));
    }
    for (const item of warningItems) {
      console.error(getItemSummary(item));
    }

    if (opts?.showAll) {
      console.error();
      console.error(joinAndCompact([
        'Valid items:',
        ansis.italic.gray('(remove `--show-all` flag to hide)'),
      ]));
      // strictly-clean items only — warn-state items are already listed above
      const validItems = envGraph.sortedConfigKeys
        .map((k) => envGraph.configSchema[k])
        .filter((i) => i.validationState === 'valid');
      for (const item of validItems) {
        console.error(getItemSummary(item));
      }
    }

    showPluginWarnings(envGraph);
    if (!opts?.noThrow) {
      throw new InvalidEnvError();
    }
  }
}
