import { SchemaError } from './errors';
import { ArrayLiteralResolver, type Resolver } from './resolver';
import { ParsedItemFilter } from './item-filter';

/**
 * A reusable allow/deny filter, shared by any decorator that selects a subset of keys
 * via `pick=[...]` / `omit=[...]` named args (e.g. `@setValuesBulk`, `@import`).
 *
 * `pick` keeps only matching keys; `omit` drops them. Entries use the shared item-selection
 * language (see {@link ParsedItemFilter}): key names, globs (`*`, `?`), `!negations`, and,
 * where the caller has item metadata to match against, `#tag` selectors. Decorator selectors
 * (`@sensitive`, ...) are never supported here: they depend on resolved values, while pick/omit
 * are applied while the graph is still loading.
 */
export type KeyFilter = { mode: 'pick' | 'omit', filter: ParsedItemFilter };

/** Build a {@link KeyFilter} from already-extracted selector entries (see {@link parseKeyFilterArgs}). */
export function buildKeyFilter(
  mode: KeyFilter['mode'],
  entries: Array<string>,
  label: string,
  opts?: { allowTagSelectors?: boolean },
): KeyFilter {
  const filter = new ParsedItemFilter(entries, `${label} ${mode}`, {
    allowDecoratorSelectors: false,
    decoratorSelectorsUnsupportedTip: `${mode}=[...] is applied while loading, before values are resolved, so it cannot select by decorator. Use the --filter flag on \`varlock load\`/\`run\` for that.`,
    allowTagSelectors: !!opts?.allowTagSelectors,
    tagSelectorsUnsupportedTip: `${label} ${mode}=[...] matches key names only; tags are declared on schema items, which this data does not have.`,
  });
  return { mode, filter };
}

/**
 * Parse `pick`/`omit` named-arg resolvers into a {@link KeyFilter}.
 *
 * Both must be static array literals of non-empty strings, and the two are mutually
 * exclusive. Returns `undefined` when neither is set (meaning "all keys"). `label` is
 * used to prefix error messages (e.g. `"@import"`). `#tag` selectors are only accepted when
 * `opts.allowTagSelectors` is set, since the caller must then supply each key's tags to
 * {@link keyMatchesFilter}.
 */
export function parseKeyFilterArgs(
  pick: Resolver | undefined,
  omit: Resolver | undefined,
  label: string,
  opts?: { allowTagSelectors?: boolean },
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
  const entries = (resolver.arrArgs ?? []).map((el) => {
    if (!el.isStatic || typeof el.staticValue !== 'string' || !el.staticValue.trim()) {
      throw new SchemaError(`${label}: ${mode} entries must be non-empty static key names, globs, or selectors`);
    }
    return el.staticValue.trim();
  });
  if (!entries.length) {
    throw new SchemaError(`${label}: ${mode} list cannot be empty`);
  }
  return buildKeyFilter(mode, entries, label, opts);
}

/**
 * Whether `key` passes the filter. An `undefined` filter matches every key. `tags` are the
 * item's `@tag(...)` names, only consulted by filters that use a `#tag` selector.
 */
export function keyMatchesFilter(key: string, filter: KeyFilter | undefined, tags: Array<string> = []): boolean {
  if (!filter) return true;
  // decorator selectors are rejected at parse time, so pre-evaluation is always conclusive
  const matched = filter.filter.preEvaluate({ key, tags }) === 'yes';
  return filter.mode === 'pick' ? matched : !matched;
}

/** Remove keys from a record that don't pass the filter (mutates in place). */
export function applyKeyFilter<T>(entries: Record<string, T>, filter: KeyFilter | undefined): void {
  if (!filter) return;
  for (const key of Object.keys(entries)) {
    if (!keyMatchesFilter(key, filter)) delete entries[key];
  }
}
