import { SchemaError } from './errors';
import { ArrayLiteralResolver, type Resolver } from './resolver';
import { globToRegExp } from './glob';

/**
 * A reusable allow/deny key filter, shared by any decorator that selects a subset of keys
 * via `pick=[...]` / `omit=[...]` named args (e.g. `@setValuesBulk`, `@import`).
 *
 * `pick` keeps only matching keys; `omit` drops them. Patterns support simple globs
 * (`*`, `?`) via {@link globToRegExp} and match case-sensitively.
 */
export type KeyFilter = { mode: 'pick' | 'omit', patterns: Array<string> };

/**
 * Parse `pick`/`omit` named-arg resolvers into a {@link KeyFilter}.
 *
 * Both must be static array literals of non-empty strings, and the two are mutually
 * exclusive. Returns `undefined` when neither is set (meaning "all keys"). `label` is
 * used to prefix error messages (e.g. `"@import"`).
 */
export function parseKeyFilterArgs(
  pick: Resolver | undefined,
  omit: Resolver | undefined,
  label: string,
): KeyFilter | undefined {
  if (pick && omit) {
    throw new SchemaError(`${label}: cannot use both pick and omit - choose one`);
  }
  const resolver = pick ?? omit;
  if (!resolver) return undefined;
  const mode = pick ? 'pick' : 'omit';
  if (!(resolver instanceof ArrayLiteralResolver)) {
    throw new SchemaError(`${label}: ${mode} must be an array literal, e.g. ${mode}=[API_KEY, DB_*]`);
  }
  const patterns = (resolver.arrArgs ?? []).map((el) => {
    if (!el.isStatic || typeof el.staticValue !== 'string' || !el.staticValue.trim()) {
      throw new SchemaError(`${label}: ${mode} entries must be non-empty static key names or globs`);
    }
    return el.staticValue.trim();
  });
  if (!patterns.length) {
    throw new SchemaError(`${label}: ${mode} list cannot be empty`);
  }
  return { mode, patterns };
}

/** Whether `key` passes the filter. An `undefined` filter matches every key. */
export function keyMatchesFilter(key: string, filter: KeyFilter | undefined): boolean {
  if (!filter) return true;
  const matched = filter.patterns.some((p) => globToRegExp(p).test(key));
  return filter.mode === 'pick' ? matched : !matched;
}

/** Remove keys from a record that don't pass the filter (mutates in place). */
export function applyKeyFilter<T>(entries: Record<string, T>, filter: KeyFilter | undefined): void {
  if (!filter) return;
  for (const key of Object.keys(entries)) {
    if (!keyMatchesFilter(key, filter)) delete entries[key];
  }
}
