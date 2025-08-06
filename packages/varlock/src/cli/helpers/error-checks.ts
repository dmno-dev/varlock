import ansis from 'ansis';
import { EnvGraph, ConfigItem, EnvSourceParseError } from '../../../env-graph';
import _ from '@env-spec/utils/my-dash';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import { gracefulExit } from 'exit-hook';

export function checkForSchemaErrors(envGraph: EnvGraph) {
  // first we check for loading/parse errors - some cases we may want to let it fail silently?
  for (const source of envGraph.dataSources) {
    // do we care about loading errors from disabled sources?
    // if (source.disabled) continue;

    // console.log(source);

    // TODO: use a formatting helper to show the error - which will include location/stack/etc appropriately
    if (source.loadingError) {
      console.log(`🚨 Error encountered while loading ${source.label}`);
      console.log(source.loadingError.message);

      // Check if the error has a location property (like EnvSourceParseError)
      if ('location' in source.loadingError) {
        console.log((source.loadingError as EnvSourceParseError).location);

        const errLoc = (source.loadingError as EnvSourceParseError).location;

        const errPreview = [
          errLoc.lineStr,
          `${ansis.gray('-'.repeat(errLoc.colNumber - 1))}${ansis.red('^')}`,
        ].join('\n');

        console.log('Error parsing .env file');
        console.log(` ${errLoc.path}:${errLoc.lineNumber}:${errLoc.colNumber}`);
        console.log(errPreview);
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
  const failingItems = _.filter(_.values(envGraph.configSchema), (item: ConfigItem) => item.validationState === 'error');

  // TODO: use service.isValid?
  if (failingItems.length > 0) {
    console.log(`\n🚨 🚨 🚨  ${ansis.bold.underline('Configuration is currently invalid ')}  🚨 🚨 🚨\n`);
    console.log('Invalid items:\n');

    _.each(failingItems, (item: ConfigItem) => {
      console.log(getItemSummary(item));
      console.log();
    });
    if (opts?.showAll) {
      console.log();
      console.log(joinAndCompact([
        'Valid items:',
        ansis.italic.gray('(remove `--show-all` flag to hide)'),
      ]));
      console.log();
      const validItems = _.filter(_.values(envGraph.configSchema), (i: ConfigItem) => !!i.isValid);
      _.each(validItems, (item: ConfigItem) => {
        console.log(getItemSummary(item));
      });
    }

    throw new InvalidEnvError();
  }
}
