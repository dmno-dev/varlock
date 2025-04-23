import ansis from 'ansis';
import { EnvGraph } from '@env-spec/env-graph';
import { _ } from '@env-spec/env-graph/utils';
import { getItemSummary, joinAndCompact } from '../../lib/formatting';
import { CliExitError } from './exit-error';

export function checkForConfigErrors(envGraph: EnvGraph, opts?: {
  showAll?: boolean
}) {
  const failingItems = _.filter(_.values(envGraph.configSchema), (item) => item.validationState === 'error');

  // TODO: use service.isValid?
  if (failingItems.length > 0) {
    console.log(`\n🚨 🚨 🚨  ${ansis.bold.underline('Configuration is currently invalid ')}  🚨 🚨 🚨\n`);
    console.log('Invalid items:\n');

    _.each(failingItems, (item) => {
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
      const validItems = _.filter(_.values(envGraph.configSchema), (i) => !!i.isValid);
      _.each(validItems, (item) => {
        console.log(getItemSummary(item));
      });
    }

    throw new CliExitError('Resolved config did not pass validation');
  }
}
