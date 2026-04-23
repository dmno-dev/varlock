import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import {
  checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors, showPluginWarnings,
} from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

export const commandSpec = define({
  name: 'load',
  description: 'Load env according to schema and resolve values',
  args: {
    format: {
      type: 'enum',
      short: 'f',
      choices: ['pretty', 'json', 'env', 'shell', 'json-full'],
      description: 'Format of output',
      default: 'pretty',
    },
    compact: {
      type: 'boolean',
      description: 'Use compact format (for json-full: no indentation, for env/shell: skip undefined values)',
    },
    'show-all': {
      type: 'boolean',
      description: 'When load is failing, show all items rather than only failing items',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @currentEnv in the schema if present',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file or directory to use as the entry point',
    },
    'clear-cache': {
      type: 'boolean',
      description: 'Clear cache and re-resolve all values',
    },
    'skip-cache': {
      type: 'boolean',
      description: 'Skip cache entirely for this invocation',
    },
  },
  examples: `
Loads and validates environment variables according to your .env files, and prints the results.
Useful for debugging locally, and in CI to print out a summary of env vars.

Examples:
  varlock load                    # Load and validate with pretty output
  varlock load --format json      # Output in JSON format
  eval "$(varlock load --format shell)"  # Load vars into current shell (useful with direnv)
  varlock load --show-all         # Show all items when validation fails
  varlock load --path .env.prod   # Load from a specific .env file
  varlock load --compact          # Use compact format - skips undefined values, no indentation for json-full
  varlock load --env production   # Load for a specific environment (⚠️ ignored if using @currentEnv!)
`.trim(),
});


/**
 * Formats a string value for safe use in a shell export statement.
 * Uses single-quoted strings to prevent shell injection via backticks, `$`, etc.
 * Single quotes within the value are escaped using the `'\''` sequence.
 */
export function formatShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const { format, compact, 'show-all': showAll } = ctx.values;

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePath: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
  });

  // For json-full, always output the serialized graph — it includes `errors` and
  // `configErrors` fields so consumers can handle failures gracefully.
  // For all other formats, exit on errors as before.
  if (format !== 'json-full') {
    checkForSchemaErrors(envGraph);
    checkForNoEnvFiles(envGraph);
  }

  if (!envGraph.rootDataSource) throw new Error('expected root data source to be set');

  // Generate types before resolving values — uses only non-env-specific schema info
  await envGraph.generateTypesIfNeeded();

  await envGraph.resolveEnvValues();

  if (format === 'json-full') {
    checkForConfigErrors(envGraph, { showAll, noThrow: true });
  } else {
    checkForConfigErrors(envGraph, { showAll });
  }

  if (format === 'pretty') {
    showPluginWarnings(envGraph);
    for (const itemKey of envGraph.sortedConfigKeys) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (format === 'json') {
    console.log(JSON.stringify(envGraph.getResolvedEnvObject(), null, 2));
  } else if (format === 'json-full') {
    const indent = compact ? 0 : 2;
    const serialized = envGraph.getSerializedGraph();
    console.log(JSON.stringify(serialized, null, indent));
    // Output JSON to stdout even on failure (so consumers can parse err.stdout),
    // but still exit non-zero so execSync callers know something is wrong
    if (serialized.errors) {
      gracefulExit(1);
    }
  } else if (format === 'env' || format === 'shell') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    const skipUndefined = compact === true;
    const prefix = format === 'shell' ? 'export ' : '';

    for (const key in resolvedEnv) {
      const value = resolvedEnv[key];

      if (value === undefined && skipUndefined) {
        continue;
      }

      let strValue: string;
      if (value === undefined) {
        strValue = '';
      } else if (typeof value === 'string') {
        if (format === 'shell') {
          strValue = formatShellValue(value);
        } else {
          strValue = `"${value.replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
        }
      } else {
        strValue = JSON.stringify(value);
      }
      console.log(`${prefix}${key}=${strValue}`);
    }
  } else {
    throw new Error(`Unknown format: ${format}`);
  }
};
