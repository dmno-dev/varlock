import type { ConfigItem } from '../../env-graph/lib/config-item';
import { SchemaError } from '../../env-graph/lib/errors';
import { computeFilteredKeys } from '../../env-graph/lib/item-filter';
import { CliExitError } from './exit-error';

/**
 * CLI-facing wrapper around the shared `--filter`/`filter=` item-selection language (see
 * {@link computeFilteredKeys}). Converts a bad `--filter` string into a `CliExitError` instead of
 * a raw `SchemaError`, so it gets the same friendly formatting as other CLI flag validation.
 */
export function resolveItemFilterKeys(
  items: Array<ConfigItem>,
  filterStr: string | undefined,
): Set<string> | undefined {
  try {
    return computeFilteredKeys(items, filterStr, '--filter');
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new CliExitError(err.message, err.tip ? { suggestion: err.tip } : undefined);
    }
    throw err;
  }
}
