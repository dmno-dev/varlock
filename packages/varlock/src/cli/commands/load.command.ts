import { writeFileSync } from 'node:fs';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { redactString } from '../../runtime/lib/redaction';
import {
  checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors, showPluginWarnings,
} from '../helpers/error-checks';
import { getCliItemFilter } from '../helpers/item-filter';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import ansis from 'ansis';
import {
  PROXY_CHILD_ENV_VAR,
  PROXY_SESSION_ID_ENV_VAR,
  PROXY_SESSION_UUID_ENV_VAR,
} from '../../proxy/env-vars';
import { getActiveProxySession } from '../../proxy/session-registry';
import { commandSpec } from './load.command-spec';

export { commandSpec };


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
    'include-internal': includeInternal,
  } = ctx.values;
  // parse --filter (or the _VARLOCK_FILTER env var) up front, so a bad filter string errors
  // before any loading/resolution work happens
  const itemFilter = getCliItemFilter(ctx.values.filter);
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
    await envGraph.runCodeGeneratorsIfNeeded();

    // A --filter scopes resolution (and validation) to what it selects plus dependencies — an
    // unrelated broken item outside the filter won't block this load, and excluded items'
    // value resolvers never run. Decorator selectors resolve item metadata first, then match
    // exactly (see EnvGraph.resolveEnvValuesForFilter).
    if (itemFilter) await itemFilter.resolveScoped(envGraph);
    else await envGraph.resolveEnvValues();

    if (outputFormat === 'json-full') {
      checkForConfigErrors(envGraph, { showAll, noThrow: true });
    } else {
      checkForConfigErrors(envGraph, { showAll });
    }
  }

  const filterKeys = itemFilter?.getFilterKeys(Object.values(envGraph.configSchema));
  const sortedConfigKeys = filterKeys
    ? envGraph.sortedConfigKeys.filter((key) => filterKeys.has(key))
    : envGraph.sortedConfigKeys;

  if ((summaryStderr || summaryFile) && outputFormat !== 'pretty') {
    const summaryLines = sortedConfigKeys.map(
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
    // include @internal items here: they aren't injected, but an agent inspecting the env
    // still needs to see they exist (redacted) to help set/debug them
    const resolvedEnv = envGraph.getResolvedEnvObject({ includeInternal: true });
    for (const itemKey of sortedConfigKeys) {
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
    for (const itemKey of sortedConfigKeys) {
      const item = envGraph.configSchema[itemKey];
      console.log(getItemSummary(item));
    }
  } else if (outputFormat === 'json') {
    const env = agent ? getRedactedEnvObject() : envGraph.getResolvedEnvObject({ filterKeys });
    console.log(JSON.stringify(env, null, 2));
  } else if (outputFormat === 'json-full') {
    const indent = compact ? 0 : 2;
    // @internal items are excluded by default, same as every other format — json-full is
    // routinely consumed programmatically (framework integrations shell out to this exact
    // command to get their injected config), so a secret-zero credential must not appear here
    // unless explicitly requested. Pass --include-internal for local human inspection.
    const serialized = envGraph.getSerializedGraph({ includeInternal: !!includeInternal, filterKeys });
    // Detect the proxy context via the unified resolver (env marker → session
    // token → ancestry), so the annotation is accurate even if the child scrubbed
    // the env marker.
    const proxySession = await getActiveProxySession().catch(() => undefined);
    if (proxySession || process.env[PROXY_CHILD_ENV_VAR] === '1') {
      (serialized as any).runtime = {
        proxy: {
          active: true,
          sessionId: proxySession?.id ?? process.env[PROXY_SESSION_ID_ENV_VAR],
          sessionUuid: proxySession?.uuid ?? process.env[PROXY_SESSION_UUID_ENV_VAR],
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
    const resolvedEnv = envGraph.getResolvedEnvObject({ filterKeys });
    // env/shell output is destined for raw environment variables, so values are emitted
    // in their process.env string form (composites become separator-joined/JSON strings);
    // the typed object above still decides quoting (bare numbers/booleans stay unquoted)
    const resolvedEnvStrings = envGraph.getResolvedEnvStringObject({ filterKeys });
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
      } else if (typeof value === 'string' || typeof value === 'object') {
        const stringForm = resolvedEnvStrings[key] ?? '';
        if (outputFormat === 'shell') {
          strValue = formatShellValue(stringForm);
        } else {
          strValue = `"${stringForm.replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
        }
      } else {
        // bare scalars (numbers/booleans) stay unquoted so re-reading infers the same type
        strValue = String(value);
      }
      console.log(`${prefix}${key}=${strValue}`);
    }
  } else {
    throw new Error(`Unknown format: ${outputFormat}`);
  }
};
