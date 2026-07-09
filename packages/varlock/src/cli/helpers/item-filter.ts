import type { ConfigItem } from '../../env-graph/lib/config-item';
import { SchemaError } from '../../env-graph/lib/errors';
import { computeFilteredKeys } from '../../env-graph/lib/item-filter';
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
