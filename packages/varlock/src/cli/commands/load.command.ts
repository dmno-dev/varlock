import { Command, CommandRunner, define } from 'gunshi';
import ansis from 'ansis';
import { _ } from '@env-spec/env-graph/utils';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { checkForConfigErrors } from '../helpers/error-checks';

export const commandSpec = define({
  name: 'load',
  description: 'Load env according to schema and resolve values',
  options: {
    format: {
      type: 'string',
      short: 'f',
      description: 'Format of output (if not pretty printed to console)',
      default: 'pretty',
    },
    'show-all': {
      type: 'boolean',
      description: 'When load is fialing, show all items rather than only failing items',
    },
  },
  run: async (ctx) => {},
});

type ExtractArgs<C> = C extends Command<infer Args> ? Args : never;

export const commandFn: CommandRunner<ExtractArgs<typeof commandSpec>> = async (ctx) => {
  const { format, 'show-all': showAll } = ctx.values;

  const envGraph = await loadVarlockEnvGraph();

  // check for load/parse errors - some cases we may want to let it fail silently?

  for (const source of envGraph.dataSources) {
    // do we care about loading errors from disabled sources?
    // if (source.disabled) continue;

    // console.log(source);

    // TODO: use a formatting helper to show the error - which will include location/stack/etc appropriately
    if (source.loadingError) {
      console.log(`🚨 Error encountered while loading ${source.label}`);
      console.log(source.loadingError.message);
      console.log(source.loadingError.location);

      const errLoc = source.loadingError.location as any;

      const errPreview = [
        errLoc.lineStr,
        `${ansis.gray('-'.repeat(errLoc.colNumber - 1))}${ansis.red('^')}`,
      ].join('\n');

      console.log('Error parsing .env file');
      console.log(` ${errLoc.path}:${errLoc.lineNumber}:${errLoc.colNumber}`);
      console.log(errPreview);

      process.exit(1);
    }
  }

  // resolve the values
  await envGraph.resolveEnvValues();

  checkForConfigErrors(envGraph, { showAll });


  if (format === 'pretty') {
    for (const itemKey in envGraph.configSchema) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (format === 'json') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    console.log(JSON.stringify(resolvedEnv, null, 2));
  } else if (format === 'env') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    for (const key in resolvedEnv) {
      const value = resolvedEnv[key];
      let strValue: string;
      if (value === undefined) {
        strValue = '';
      } else if (typeof value === 'string') {
        strValue = `"${value.replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
      } else {
        strValue = JSON.stringify(value);
      }
      console.log(`${key}=${strValue}`);
    }
  } else {
    throw new Error(`Unknown format: ${format}`);
  }

  // const resolvedEnv = envGraph.getResolvedEnvObject();
  // console.log(resolvedEnv);
};
