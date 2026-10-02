import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { getItemSummary } from '../../lib/formatting';
import { redactString } from '../../runtime/lib/redaction';
import {
  checkForConfigErrors, checkForNoEnvFiles, checkForSchemaErrors, showPluginWarnings,
} from '../helpers/error-checks';
import { getCliItemFilter } from '../helpers/item-filter';
import { applyFrozenArg, getPinnedGraphForResolution, getPinnedItemFilter } from '../helpers/pinned-env';
import { getFrozenEnvFileInPlay } from '../../lib/frozen-env-file';
import { CliExitError } from '../helpers/exit-error';
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
  const cliItemFilter = getCliItemFilter(ctx.values.filter, { cliPaths: ctx.values.path });
  // --agent defaults to json if no explicit --format was set, but respects --format if provided
  const outputFormat = agent && format === 'pretty' ? 'json' : format;

  if (agent && (outputFormat === 'env' || outputFormat === 'shell')) {
    throw new Error(`--agent is not compatible with --format ${outputFormat}`);
  }

  // A `varlock freeze` pin is applied only when named explicitly (`--frozen`,
  // `_VARLOCK_USE_FROZEN_ENV=1` or a path, or a frozen payload trusted via `_VARLOCK_USE_INJECTED_ENV=1`), showing the
  // pinned values plus any `@dynamic=boot` keys resolved live. That is also how
  // `varlock/auto-load` hands a pin to the CLI. A file that is merely present is left alone,
  // because every framework integration resolves through `load` - but `varlock run` and
  // auto-load WOULD boot from it, so say that rather than silently disagreeing with them.
  applyFrozenArg(ctx.values.frozen);
  const pinned = getPinnedGraphForResolution();
  if (pinned) {
    // same contradiction `varlock run` rejects: these change what a fresh resolution
    // produces, but the pin fixes it. (`--env` is left alone: the Next.js integration always
    // passes it, and a pin applies its own recorded environment as the fallback.)
    const resolutionFlags = [
      ctx.values.path?.length ? '--path' : undefined,
      ctx.values.filter ? '--filter' : undefined,
      ctx.values['clear-cache'] ? '--clear-cache' : undefined,
      ctx.values['skip-cache'] ? '--skip-cache' : undefined,
    ].filter(Boolean) as Array<string>;
    if (resolutionFlags.length) {
      const what = pinned.source === 'frozen-file' ? `a frozen env file (${pinned.filePath})` : 'a frozen __VARLOCK_ENV payload';
      throw new CliExitError(`${what} cannot be combined with ${resolutionFlags.join(', ')}`, {
        suggestion: 'These flags change what a fresh resolution produces, but the pin fixes it. Drop them, or drop --frozen / _VARLOCK_USE_FROZEN_ENV.',
      });
    }
  }
  // a pin is final, so it defines the item set rather than any filter
  const itemFilter = pinned ? getPinnedItemFilter(pinned) : cliItemFilter;
  const ignoredFrozenFile = pinned ? undefined : getFrozenEnvFileInPlay(process.env, process.cwd());
  if (ignoredFrozenFile) {
    const relPath = path.relative(process.cwd(), ignoredFrozenFile) || ignoredFrozenFile;
    console.error(ansis.yellow(
      `⚠ ${relPath} is present: \`varlock run\` and \`varlock/auto-load\` boot from it, but this shows resolution from .env files.`,
    ));
    console.error(ansis.gray(
      '  Use `varlock load --frozen` to see the pinned values, or delete the file if it is left over from a local freeze.',
    ));
  }
  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePaths: ctx.values.path,
    clearCache: ctx.values['clear-cache'],
    skipCache: ctx.values['skip-cache'],
    pinned,
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
    checkForNoEnvFiles(envGraph, { noThrow: true, allowOptOut: true });
  } else {
    const result = checkForSchemaErrors(envGraph);
    hadSchemaOutput = result.hasOutput;
    checkForNoEnvFiles(envGraph, { allowOptOut: true });
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
    // shell format: `export KEY=` would set an empty string in the shell, misrepresenting an
    // unset item — skip undefined items unless `@injectUndefinedAsEmpty` opts into that.
    // env format keeps its `KEY=` lines, which round-trip to undefined in the varlock dialect.
    const skipUndefined = compact === true
      || (outputFormat === 'shell' && !envGraph.injectUndefinedAsEmpty);
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
