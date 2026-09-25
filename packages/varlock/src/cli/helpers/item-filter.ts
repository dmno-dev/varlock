import type { ConfigItem } from '../../env-graph/lib/config-item';
import type { EnvGraph } from '../../env-graph/lib/env-graph';
import { SchemaError } from '../../env-graph/lib/errors';
import { ParsedItemFilter } from '../../env-graph/lib/item-filter';
import { readVarlockPackageJsonConfig } from '../../lib/package-json-config';
import { CliExitError } from './exit-error';

export type CliItemFilter = {
  /**
   * Resolve only what the filter selects (see `EnvGraph.resolveEnvValuesForFilter()`), so
   * `load`/`run` skip resolving (and validating) items outside the filter entirely — e.g. a
   * build step scoped to `--filter="#frontend"` doesn't need an unrelated broken backend-only
   * var to be valid, and `--filter="!@dynamic"` at build time skips runtime-only vars whose
   * values (and `@required` checks) only make sense at runtime. Decorator selectors resolve
   * item metadata first (cheap), then match exactly — excluded items' value resolvers never run.
   */
  resolveScoped(graph: EnvGraph): Promise<void>;
  /** the keys passing the filter — call after resolution, when decorator getters are accurate */
  getFilterKeys(items: Array<ConfigItem>): Set<string>;
};

/**
 * The `varlock.filter` configured in package.json, validated. It is only meaningful next to
 * `varlock.loadPath` (it scopes what a shared schema exposes to this package), so setting it
 * alone is an error rather than a silent no-op. Not applied when `--path` overrides `loadPath`.
 */
export function getPackageJsonFilter(opts?: { cliPaths?: Array<string>, cwd?: string }): string | undefined {
  // --path bypasses package.json loadPath entirely, so its filter is neither applied nor validated
  if (opts?.cliPaths?.length) return undefined;
  const pkgConfig = readVarlockPackageJsonConfig({ cwd: opts?.cwd });
  if (pkgConfig?.filter === undefined) return undefined;
  if (typeof pkgConfig.filter !== 'string' || !pkgConfig.filter.trim()) {
    throw new CliExitError('`varlock.filter` in package.json must be a non-empty string', {
      suggestion: 'Use the same selectors as --filter, e.g. "filter": "#frontend" or "PUBLIC_*,!PUBLIC_DEBUG"',
    });
  }
  if (!pkgConfig.loadPath) {
    throw new CliExitError('`varlock.filter` in package.json requires `varlock.loadPath`', {
      suggestion: 'Set `varlock.loadPath` to the shared schema this filter applies to, or remove `varlock.filter` and pass --filter instead.',
    });
  }
  return pkgConfig.filter;
}

/**
 * CLI-facing wrapper around the shared `--filter`/`filter=` item-selection language (see
 * {@link ParsedItemFilter}). Parses once, up front, converting a bad `--filter` string into a
 * `CliExitError` instead of a raw `SchemaError`, so it gets the same friendly formatting as other
 * CLI flag validation.
 *
 * Falls back to the `_VARLOCK_FILTER` env var when `--filter` isn't passed - useful for build-time
 * integrations (e.g. the Vite plugin) that have no way to accept CLI flags. An explicit `--filter`
 * always takes precedence over the env var, matching the `_VARLOCK_REDACT_STDOUT` precedent.
 * When neither is set, `varlock.filter` from package.json applies (see {@link getPackageJsonFilter}).
 * Returns `undefined` when none is set, meaning "no filtering".
 */
export function getCliItemFilter(
  flagValue: string | undefined,
  opts?: {
    /** `--path` values, which bypass package.json `loadPath` and therefore its `filter` too */
    cliPaths?: Array<string>,
    /** where to look for package.json (defaults to process.cwd()) */
    cwd?: string,
  },
): CliItemFilter | undefined {
  const pkgFilter = getPackageJsonFilter(opts);
  let filterStr: string | undefined;
  let source: string;
  if (flagValue) {
    filterStr = flagValue;
    source = '--filter';
  } else if (process.env._VARLOCK_FILTER) {
    filterStr = process.env._VARLOCK_FILTER;
    source = '_VARLOCK_FILTER env var';
  } else {
    filterStr = pkgFilter;
    source = 'package.json varlock.filter';
  }
  if (!filterStr) return undefined;

  let parsed: ParsedItemFilter;
  try {
    parsed = new ParsedItemFilter(filterStr, source);
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new CliExitError(err.message, err.tip ? { suggestion: err.tip } : undefined);
    }
    throw err;
  }

  return {
    async resolveScoped(graph) {
      await graph.resolveEnvValuesForFilter(parsed);
    },
    getFilterKeys(items) {
      const keys = parsed.computeKeys(items);
      if (!keys.size) {
        // a typo'd key/tag would otherwise silently produce empty output (or a child process
        // with no schema vars on `run`) - warn on stderr, which stays out of piped stdout
        console.error(`[varlock] ⚠️  ${source} "${filterStr}" matched no items`);
      }
      return keys;
    },
  };
}
