import { writeFileSync } from 'node:fs';
import { define } from 'gunshi';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { redactString } from '../../runtime/lib/redaction';
import {
  checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors, showPluginWarnings,
} from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import ansis from 'ansis';
import {
  PROXY_CHILD_ENV_VAR,
  PROXY_SESSION_ID_ENV_VAR,
  PROXY_SESSION_UUID_ENV_VAR,
} from '../../proxy/env-vars';

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
    agent: {
      type: 'boolean',
      description: 'Agent-safe mode: redact sensitive values (defaults to JSON format if --format is not set)',
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
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    'summary-stderr': {
      type: 'boolean',
      description: 'Also output the pretty (redacted) summary to stderr (useful alongside --format json-full to get both machine-readable output on stdout and a human-readable summary on stderr)',
    },
    'summary-file': {
      type: 'string',
      description: 'Also write the pretty (redacted) summary to a file path (useful for CI, e.g. $GITHUB_STEP_SUMMARY)',
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
  varlock load -p ./envs -p ./overrides  # Load from multiple directories
  varlock load --compact          # Use compact format - skips undefined values, no indentation for json-full
  varlock load --env production   # Load for a specific environment (⚠️ ignored if using @currentEnv!)
  varlock load --format json-full --summary-stderr   # JSON on stdout + redacted human summary on stderr
  varlock load --format json-full --summary-file /tmp/summary.txt   # JSON on stdout + redacted human summary written to file
  varlock load --agent            # Agent-safe JSON output with sensitive values redacted
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
  const {
    format, compact, 'show-all': showAll, 'summary-stderr': summaryStderr, 'summary-file': summaryFile, agent,
  } = ctx.values;
  // --agent defaults to json if no explicit --format was set, but respects --format if provided
  const outputFormat = agent && format === 'pretty' ? 'json' : format;

  if (agent && (outputFormat === 'env' || outputFormat === 'shell')) {
    throw new Error(`--agent is not compatible with --format ${outputFormat}`);
  }

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePaths: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
  });

  // For json-full, still run the checks so their pretty output goes to stderr,
  // but use noThrow so we can continue to output JSON to stdout.
  // For all other formats, exit on errors as before.
  let hasSchemaErrors = false;
  let hadSchemaOutput = false;
  if (outputFormat === 'json-full') {
    const result = checkForSchemaErrors(envGraph, { noThrow: true });
    hasSchemaErrors = result.hasErrors;
    hadSchemaOutput = result.hasOutput;
    checkForNoEnvFiles(envGraph, { noThrow: true });
  } else {
    const result = checkForSchemaErrors(envGraph);
    hadSchemaOutput = result.hasOutput;
    checkForNoEnvFiles(envGraph);
  }

  if (!envGraph.rootDataSource) throw new Error('expected root data source to be set');

  // Skip resolution + config checks when schema has errors — the downstream
  // errors would just be noise caused by the parse/schema failure
  if (!hasSchemaErrors) {
    // Generate types before resolving values — uses only non-env-specific schema info
    await envGraph.generateTypesIfNeeded();

    await envGraph.resolveEnvValues();

    if (outputFormat === 'json-full') {
      checkForConfigErrors(envGraph, { showAll, noThrow: true });
    } else {
      checkForConfigErrors(envGraph, { showAll });
    }
  }

  if ((summaryStderr || summaryFile) && outputFormat !== 'pretty') {
    const summaryLines = envGraph.sortedConfigKeys.map(
      (key) => getItemSummary(envGraph.configSchema[key]),
    );
    const summaryStr = `${summaryLines.join('\n')}\n`;
    if (summaryStderr) {
      process.stderr.write(summaryStr);
    }
    if (summaryFile) {
      writeFileSync(summaryFile, summaryStr);
    }
  }

  /** When --agent is set, return a copy of the resolved env with sensitive values redacted */
  function getRedactedEnvObject() {
    const redactedEnv: Record<string, unknown> = {};
    const resolvedEnv = envGraph.getResolvedEnvObject();
    for (const itemKey of envGraph.sortedConfigKeys) {
      const item = envGraph.configSchema[itemKey];
      const value = resolvedEnv[itemKey];
      if (item.isSensitive && typeof value === 'string') {
        redactedEnv[itemKey] = redactString(value);
      } else if (item.isSensitive && value !== undefined) {
        redactedEnv[itemKey] = '[REDACTED]';
      } else {
        redactedEnv[itemKey] = value;
      }
    }
    return redactedEnv;
  }

  if (outputFormat === 'pretty') {
    showPluginWarnings(envGraph);
    if (hadSchemaOutput) {
      console.error();
    }
    console.error(ansis.bold.green('-- Resolved config --'));
    for (const itemKey of envGraph.sortedConfigKeys) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (outputFormat === 'json') {
    const env = agent ? getRedactedEnvObject() : envGraph.getResolvedEnvObject();
    console.log(JSON.stringify(env, null, 2));
  } else if (outputFormat === 'json-full') {
    const indent = compact ? 0 : 2;
    const serialized = envGraph.getSerializedGraph();
    if (process.env[PROXY_CHILD_ENV_VAR] === '1') {
      (serialized as any).runtime = {
        proxy: {
          active: true,
          sessionId: process.env[PROXY_SESSION_ID_ENV_VAR],
          sessionUuid: process.env[PROXY_SESSION_UUID_ENV_VAR],
        },
      };
    }
    if (agent) {
      for (const key in serialized.config) {
        const item = serialized.config[key];
        if (item.isSensitive && typeof item.value === 'string') {
          item.value = redactString(item.value);
        } else if (item.isSensitive && item.value !== undefined) {
          item.value = '[REDACTED]';
        }
      }
    }
    console.log(JSON.stringify(serialized, null, indent));
    // Output JSON to stdout even on failure (so consumers can parse err.stdout),
    // but still exit non-zero so execSync callers know something is wrong
    if (serialized.errors) {
      gracefulExit(1);
    }
  } else if (outputFormat === 'env' || outputFormat === 'shell') {
    const resolvedEnv = envGraph.getResolvedEnvObject();
    const skipUndefined = compact === true;
    const prefix = outputFormat === 'shell' ? 'export ' : '';

    for (const key in resolvedEnv) {
      const value = resolvedEnv[key];

      if (value === undefined && skipUndefined) {
        continue;
      }

      let strValue: string;
      if (value === undefined) {
        strValue = '';
      } else if (typeof value === 'string') {
        if (outputFormat === 'shell') {
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
    throw new Error(`Unknown format: ${outputFormat}`);
  }
};
