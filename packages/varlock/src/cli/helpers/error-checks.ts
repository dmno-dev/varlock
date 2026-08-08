import ansis from 'ansis';
import { EnvGraph, FileBasedDataSource } from '../../env-graph';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import {
  LoadingError, ParseError, VarlockError,
} from '../../env-graph/lib/errors';
import { CliExitError } from './exit-error';

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

export function checkForNoEnvFiles(envGraph: EnvGraph, opts?: { noThrow?: boolean }) {
  if (Object.keys(envGraph.configSchema).length > 0) return;

  // The graph owns what counts as unusable (and which of the two reasons it is),
  // so this stays in step with what `getSerializedGraph` reports in `errors.root`.
  const emptyGraphError = envGraph.getEmptyGraphError();
  if (!emptyGraphError) {
    // some other root error already explains the empty graph — it was reported
    // by checkForSchemaErrors, so don't pile a misleading message on top
    if (opts?.noThrow) return;
    throw new CliExitError('Schema error', { silent: true });
  }

  console.error(`🚨 ${emptyGraphError.message}\n`);
  if (emptyGraphError.tip) console.error(emptyGraphError.tip);
  if (opts?.noThrow) return;
  throw new CliExitError('No env files', { silent: true });
}

export function checkForSchemaErrors(envGraph: EnvGraph, opts?: { noThrow?: boolean }) {
  let hasErrors = false;
  let hasOutput = false;
  for (const source of envGraph.sortedDataSources) {
    const warnings = source.errors.filter((e) => e.isWarning);
    const errors = source.errors.filter((e) => !e.isWarning);
    const resolutionErrors = source.resolutionErrors;

    if (!warnings.length && !errors.length && !resolutionErrors.length) continue;
    hasOutput = true;

    // group by error type for clearer output
    const loadingErrors = errors.filter((e) => e instanceof LoadingError || e instanceof ParseError);
    const otherErrors = errors.filter((e) => !(e instanceof LoadingError || e instanceof ParseError));

    // single header per file
    const hasAnyError = errors.length || resolutionErrors.length;
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

export class InvalidEnvError extends Error {
  constructor() {
    super('Resolved config/env did not pass validation');
  }
  getFormattedOutput() {
    return `\n💥 ${ansis.red(this.message)} 💥\n`;
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
