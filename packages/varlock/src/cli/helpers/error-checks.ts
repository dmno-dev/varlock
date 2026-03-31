import ansis from 'ansis';
import { gracefulExit } from 'exit-hook';
import _ from '@env-spec/utils/my-dash';
import { EnvGraph, ConfigItem, FileBasedDataSource } from '../../env-graph';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import { VarlockError } from '../../env-graph/lib/errors';


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

export function checkForNoEnvFiles(envGraph: EnvGraph) {
  if (Object.keys(envGraph.configSchema).length === 0) {
    const displayPath = envGraph.basePath ?? process.cwd();
    const hasLoadedFiles = envGraph.sortedDataSources.some((s) => s instanceof FileBasedDataSource);
    if (!hasLoadedFiles) {
      console.error(`🚨 No .env files found in ${displayPath}\n`);
      console.error('Run `varlock init` to create a .env.schema file, or use `--path` to specify a file or directory.');
    } else {
      console.error(`🚨 No config items defined in ${displayPath}\n`);
      console.error('Add items to your .env.schema file to get started.');
    }
    return gracefulExit(1);
  }
}

export function checkForSchemaErrors(envGraph: EnvGraph) {
  // first we check for loading/parse errors - some cases we may want to let it fail silently?
  for (const source of envGraph.sortedDataSources) {
    // do we care about loading errors from disabled sources?
    // if (source.disabled) continue;

    if (source.loadingError) {
      console.error(`🚨 Error encountered while loading ${source.label}\n`);

      console.error(source.loadingError.message);
      showErrorLocationDetails(source.loadingError);

      // For plugin loading errors, show the full stack trace since it's usually
      // a runtime error from executing the plugin code
      if (source.loadingError.stack && !(source.loadingError instanceof VarlockError)) {
        console.error(`\n${ansis.dim('Stack trace:')}`);
        console.error(ansis.dim(source.loadingError.stack));
      }

      return gracefulExit(1);
    }
    // TODO: unify this with the above!
    if (source.schemaErrors.length) {
      console.error(`🚨 Error(s) encountered in ${source.label}`);

      for (const schemaErr of source.schemaErrors) {
        console.error(`- ${schemaErr.message}`);
        showErrorLocationDetails(schemaErr);
      }
      return gracefulExit(1);
    }
  }

  // now we check for any schema errors - where something about how things are wired up is invalid
  // NOTE - we should not have run any resolution yet
  // TODO: make sure we are calling this before attempting to resolve values
  // const failingItems = _.filter(_.values(envGraph.configSchema), (item) => item.validationState === 'error');
  // if (failingItems.length > 0) {
  //   throw new CliExitError('Schema is currently invalid');
  // }
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
  showAll?: boolean
}) {
  // check for root decorator "execution"
  for (const source of envGraph.sortedDataSources) {
    if (source.resolutionErrors.length) {
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



  const failingItems = envGraph.sortedConfigKeys
    .map((k) => envGraph.configSchema[k])
    .filter((item) => item.validationState === 'error');

  // TODO: use service.isValid?
  if (failingItems.length > 0) {
    console.error(`\n🚨 🚨 🚨  ${ansis.bold.underline('Configuration is currently invalid ')}  🚨 🚨 🚨\n`);
    console.error('Invalid items:\n');

    _.each(failingItems, (item: ConfigItem) => {
      console.error(getItemSummary(item));
      console.error();
    });
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
    throw new InvalidEnvError();
  }
}
