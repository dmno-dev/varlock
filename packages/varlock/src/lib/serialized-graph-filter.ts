import { ParsedItemFilter } from '../env-graph/lib/item-filter';
import type { SerializedEnvGraph } from '../env-graph/lib/env-graph';

/**
 * Apply a `--filter` expression (key globs, `!negations`, `#tags`, `@sensitive`, `@dynamic`) to
 * the `config` of a serialized env graph (`varlock load --format json-full`), returning the keys
 * that pass. Lets tools that already hold the resolved graph pick a subset (for example the
 * bindings for one Worker) without re-running varlock.
 *
 * `@required` cannot be evaluated here: json-full does not carry requiredness, so a filter using
 * it is rejected. `label` prefixes error messages (e.g. `bindingsFilter`).
 */
export function filterSerializedGraphKeys(
  config: SerializedEnvGraph['config'],
  filterStr: string,
  label = 'filter',
): Set<string> {
  if (/(^|,)\s*!?@required\b/.test(filterStr)) {
    throw new Error(`${label}: @required is not available when filtering a serialized graph`);
  }
  const parsed = new ParsedItemFilter(filterStr, label);
  return parsed.computeKeys(Object.entries(config).map(([key, item]) => ({
    key,
    isSensitive: item.isSensitive,
    isDynamic: item.isDynamic ?? item.isSensitive,
    isRequired: false,
    tags: item.tags ?? [],
  })));
}
