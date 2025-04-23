import { Command, CommandRunner, define } from 'gunshi';
import ansis from 'ansis';
import { _ } from '@env-spec/env-graph/utils';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { checkForConfigErrors, checkForSchemaErrors } from '../helpers/error-checks';

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
  checkForSchemaErrors(envGraph);
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
