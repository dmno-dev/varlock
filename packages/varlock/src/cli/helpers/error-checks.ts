import ansis from 'ansis';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph, ConfigItem, FileBasedDataSource } from '../../env-graph';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import { ParseError, VarlockError } from '../../env-graph/lib/errors';


export class FatalSchemaError extends Error {
  constructor(message = 'Fatal schema error') {
    super(message);
  }
  getFormattedOutput() {
    return ''; // details already logged to stderr
  }
}

function showErrorLocationDetails(err: Error) {
  if (!(err instanceof VarlockError) || !err.location) return;
  const errLoc = err.location;
  const errPreview = [
    errLoc.lineStr,
    `${ansis.gray('-'.repeat(errLoc.colNumber - 1))}${ansis.red('^')}`,
  ].join('\n');

  console.error('');
  console.error(`📂 ${errLoc.id}:${errLoc.lineNumber}:${errLoc.colNumber}`);
  console.error(errPreview);
}

export function checkForNoEnvFiles(envGraph: EnvGraph, opts?: { noThrow?: boolean }) {
  if (Object.keys(envGraph.configSchema).length === 0) {
    // If a source has a parse error, the schema couldn't be read at all so
    // "no config items defined" is misleading — the parse error (already
    // reported by checkForSchemaErrors) is the real problem.
    const hasParseErrors = envGraph.sortedDataSources.some((s) => s.loadingError instanceof ParseError);
    if (hasParseErrors) {
      if (opts?.noThrow) return;
      throw new FatalSchemaError('Parse error');
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
    throw new FatalSchemaError('No env files');
  }
}

export function checkForSchemaErrors(envGraph: EnvGraph, opts?: { noThrow?: boolean }) {
  // first we check for loading/parse errors - some cases we may want to let it fail silently?
  let hasErrors = false;
  for (const source of envGraph.sortedDataSources) {
    // do we care about loading errors from disabled sources?
    // if (source.disabled) continue;

    if (source.loadingError) {
      hasErrors = true;
      console.error(`🚨 Error encountered while loading ${source.label}\n`);

      console.error(source.loadingError.message);
      showErrorLocationDetails(source.loadingError);

      // For plugin loading errors, show the full stack trace since it's usually
      // a runtime error from executing the plugin code
      if (source.loadingError.stack && !(source.loadingError instanceof VarlockError)) {
        console.error(`\n${ansis.dim('Stack trace:')}`);
        console.error(ansis.dim(source.loadingError.stack));
      }

      if (!opts?.noThrow) throw new FatalSchemaError('Loading error');
    }
    // TODO: unify this with the above!
    const schemaWarnings = source.schemaErrors.filter((e) => e.isWarning);
    const schemaErrors = source.schemaErrors.filter((e) => !e.isWarning);

    for (const warning of schemaWarnings) {
      console.error(ansis.yellow(`⚠️  [WARNING] ${warning.message} (${source.label})`));
      showErrorLocationDetails(warning);
    }

    if (schemaErrors.length) {
      hasErrors = true;
      console.error(`🚨 Error(s) encountered in ${source.label}`);

      for (const schemaErr of schemaErrors) {
        console.error(`- ${schemaErr.message}`);
        showErrorLocationDetails(schemaErr);
      }
      if (!opts?.noThrow) throw new FatalSchemaError('Schema error');
    }
  }

  // now we check for any schema errors - where something about how things are wired up is invalid
  // NOTE - we should not have run any resolution yet
  // TODO: make sure we are calling this before attempting to resolve values
  // const failingItems = _.filter(_.values(envGraph.configSchema), (item) => item.validationState === 'error');
  // if (failingItems.length > 0) {
  //   throw new CliExitError('Schema is currently invalid');
  // }
  return hasErrors;
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
  // check for root decorator "execution"
  let hasRootDecoratorErrors = false;
  for (const source of envGraph.sortedDataSources) {
    if (source.resolutionErrors.length) {
      hasRootDecoratorErrors = true;
      console.error(`🚨 Root decorator error(s) in ${source.label}`);

      for (const err of source.resolutionErrors) {
        console.error(`- ${err.message}`);
        if (err instanceof VarlockError && err.tip) {
          for (const line of err.tip.split('\n')) {
            console.error(`  ${line}`);
          }
        }
        showErrorLocationDetails(err);
      }
    }
  }

  if (hasRootDecoratorErrors) {
    if (!opts?.noThrow) throw new FatalSchemaError('Root decorator error');
    return;
  }

  const failingItems = envGraph.sortedConfigKeys
    .map((k) => envGraph.configSchema[k])
    .filter((item) => item.validationState === 'error');
  const warningItems = envGraph.sortedConfigKeys
    .map((k) => envGraph.configSchema[k])
    .filter((item) => item.validationState === 'warn');

  // TODO: use service.isValid?
  if (failingItems.length > 0) {
    console.error(`\n🚨 🚨 🚨  ${ansis.bold.underline('Configuration is currently invalid ')}  🚨 🚨 🚨\n`);
    console.error('Invalid items:\n');

    _.each(failingItems, (item: ConfigItem) => {
      console.error(getItemSummary(item));
      console.error();
    });

    if (warningItems.length) {
      console.error('Items with warnings:\n');
      _.each(warningItems, (item: ConfigItem) => {
        console.error(getItemSummary(item));
        console.error();
      });
    }
    if (opts?.showAll) {
      console.error();
      console.error(joinAndCompact([
        'Valid items:',
        ansis.italic.gray('(remove `--show-all` flag to hide)'),
      ]));
      console.error();
      const validItems = envGraph.sortedConfigKeys
        .map((k) => envGraph.configSchema[k])
        .filter((i) => !!i.isValid);
      _.each(validItems, (item: ConfigItem) => {
        console.error(getItemSummary(item));
      });
    }

    showPluginWarnings(envGraph);
    if (!opts?.noThrow) {
      throw new InvalidEnvError();
    }
  }
}
