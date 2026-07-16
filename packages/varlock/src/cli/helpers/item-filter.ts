import type { ConfigItem } from '../../env-graph/lib/config-item';
import type { EnvGraph } from '../../env-graph/lib/env-graph';
import { SchemaError } from '../../env-graph/lib/errors';
import { ParsedItemFilter } from '../../env-graph/lib/item-filter';
import { CliExitError } from './exit-error';

export type CliItemFilter = {
  /**
   * Keys to pass to `resolveEnvValues()` (already includes transitive deps), so `load`/`run` can
   * skip resolving (and validating) items outside the filter entirely — e.g. a build step scoped
   * to `--filter="#frontend"` doesn't need an unrelated broken backend-only var to be valid.
   * Returns `undefined` (= resolve everything) for filters using `@sensitive`/`@required`: their
   * matches aren't knowable until the graph is resolved (see `usesDecoratorSelector`), so there's
   * nothing to scope down to.
   */
  getResolveKeys(graph: EnvGraph): Array<string> | undefined;
  /** the keys passing the filter — call after `resolveEnvValues()`, when decorator getters are accurate */
  getFilterKeys(items: Array<ConfigItem>): Set<string>;
};

/**
 * CLI-facing wrapper around the shared `--filter`/`filter=` item-selection language (see
 * {@link ParsedItemFilter}). Parses once, up front, converting a bad `--filter` string into a
 * `CliExitError` instead of a raw `SchemaError`, so it gets the same friendly formatting as other
 * CLI flag validation.
 *
 * Falls back to the `_VARLOCK_FILTER` env var when `--filter` isn't passed - useful for build-time
 * integrations (e.g. the Vite plugin) that have no way to accept CLI flags. An explicit `--filter`
 * always takes precedence over the env var, matching the `_VARLOCK_REDACT_STDOUT` precedent.
 * Returns `undefined` when neither is set, meaning "no filtering".
 */
export function getCliItemFilter(flagValue: string | undefined): CliItemFilter | undefined {
  const filterStr = flagValue ?? process.env._VARLOCK_FILTER;
  if (!filterStr) return undefined;

  let parsed: ParsedItemFilter;
  try {
    parsed = new ParsedItemFilter(filterStr, '--filter');
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new CliExitError(err.message, err.tip ? { suggestion: err.tip } : undefined);
    }
    throw err;
  }

  return {
    getResolveKeys(graph) {
      if (parsed.usesDecoratorSelector) return undefined;
      const matchedKeys = parsed.computeKeys(Object.values(graph.configSchema));
      return [...graph.expandKeysWithTransitiveDeps(matchedKeys)];
    },
    getFilterKeys(items) {
      const keys = parsed.computeKeys(items);
      if (!keys.size) {
        // a typo'd key/tag would otherwise silently produce empty output (or a child process
        // with no schema vars on `run`) - warn on stderr, which stays out of piped stdout
        const source = flagValue ? '--filter' : '_VARLOCK_FILTER env var';
        console.error(`[varlock] ⚠️  ${source} "${filterStr}" matched no items`);
      }
      return keys;
    },
  };
}
