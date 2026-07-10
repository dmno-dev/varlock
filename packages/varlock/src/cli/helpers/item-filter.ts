import type { ConfigItem } from '../../env-graph/lib/config-item';
import type { EnvGraph } from '../../env-graph/lib/env-graph';
import { SchemaError } from '../../env-graph/lib/errors';
import { computeFilteredKeys, filterUsesDecoratorSelector } from '../../env-graph/lib/item-filter';
import { CliExitError } from './exit-error';

/**
 * CLI-facing wrapper around the shared `--filter`/`filter=` item-selection language (see
 * {@link computeFilteredKeys}). Converts a bad `--filter` string into a `CliExitError` instead of
 * a raw `SchemaError`, so it gets the same friendly formatting as other CLI flag validation.
 *
 * Falls back to the `_VARLOCK_FILTER` env var when `--filter` isn't passed - useful for build-time
 * integrations (e.g. the Vite plugin) that have no way to accept CLI flags. An explicit `--filter`
 * always takes precedence over the env var, matching the `_VARLOCK_REDACT_STDOUT` precedent.
 */
export function resolveItemFilterKeys(
  items: Array<ConfigItem>,
  filterStr: string | undefined,
): Set<string> | undefined {
  const effectiveFilterStr = filterStr ?? process.env._VARLOCK_FILTER;
  try {
    return computeFilteredKeys(items, effectiveFilterStr, '--filter');
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new CliExitError(err.message, err.tip ? { suggestion: err.tip } : undefined);
    }
    throw err;
  }
}

export type FilterResolutionPlan = {
  /** keys to pass to `resolveEnvValues()` (already includes transitive deps); `undefined` = resolve everything */
  resolveKeys: Array<string> | undefined;
};

/**
 * Decides how much of the graph `--filter` actually needs resolved, so `load`/`run` can skip
 * resolving (and validating) items outside the filter entirely — e.g. a build step scoped to
 * `--filter="#frontend"` doesn't need an unrelated broken backend-only var to be valid.
 *
 * `@sensitive`/`@required` selectors can't be scoped this way — their matches aren't knowable
 * until the graph is resolved (see {@link filterUsesDecoratorSelector}), so a filter using either
 * falls back to resolving everything, same as today.
 */
export function planFilterResolution(
  graph: EnvGraph,
  filterStr: string | undefined,
): FilterResolutionPlan {
  const effectiveFilterStr = filterStr ?? process.env._VARLOCK_FILTER;
  if (!effectiveFilterStr) return { resolveKeys: undefined };

  let usesDecoratorSelector: boolean;
  try {
    usesDecoratorSelector = filterUsesDecoratorSelector(effectiveFilterStr, '--filter');
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new CliExitError(err.message, err.tip ? { suggestion: err.tip } : undefined);
    }
    throw err;
  }
  if (usesDecoratorSelector) return { resolveKeys: undefined };

  const matchedKeys = resolveItemFilterKeys(Object.values(graph.configSchema), effectiveFilterStr)!;
  return { resolveKeys: [...graph.expandKeysWithTransitiveDeps(matchedKeys)] };
}
