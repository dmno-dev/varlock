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
  if (Object.keys(envGraph.configSchema).length === 0) {
    // If a source has a parse error, the schema couldn't be read at all so
    // "no config items defined" is misleading — the parse error (already
    // reported by checkForSchemaErrors) is the real problem.
    const hasParseErrors = envGraph.sortedDataSources.some((s) => s.loadingError instanceof ParseError);
    if (hasParseErrors) {
      if (opts?.noThrow) return;
      throw new CliExitError('Parse error', { silent: true });
    }

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
    const warnings = source.errors.filter((e) => e.isWarning);
    const errors = source.errors.filter((e) => !e.isWarning);

    if (!warnings.length && !errors.length) continue;
    hasOutput = true;

    // group by error type for clearer output
    const loadingErrors = errors.filter((e) => e instanceof LoadingError || e instanceof ParseError);
    const otherErrors = errors.filter((e) => !(e instanceof LoadingError || e instanceof ParseError));

    // single header per file
    console.error(ansis.bold[errors.length ? 'red' : 'yellow'](`-- Problems encountered in ${source.label} --`));

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

    if (errors.length) {
      hasErrors = true;
      if (!opts?.noThrow) throw new CliExitError('Schema error', { silent: true });
    }

    // check for errors from decorator execute() (e.g., invalid plugin options like cacheTtl)
    if (source.resolutionErrors.length) {
      console.error(`🚨 Error(s) during initialization of ${source.label}`);

      for (const resErr of source.resolutionErrors) {
        console.error(`- ${resErr.message}`);
        showErrorLocationDetails(resErr);
      }
      return gracefulExit(1);
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
      const validItems = envGraph.sortedConfigKeys
        .map((k) => envGraph.configSchema[k])
        .filter((i) => !!i.isValid);
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
