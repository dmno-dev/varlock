import { SchemaError } from './errors';
import { globToRegExp } from './glob';

/**
 * Shared item-selection language used by the CLI `--filter` flag (`varlock load`/`run`) and the
 * `filter=` arg on code-generation decorators (e.g. `@generateTsTypes(filter=#billing)`). A comma-
 * separated list of selectors:
 * - a key name or glob (`STRIPE_*`) to select matching items
 * - `!selector` to negate any of the below (e.g. `!DEBUG_*`)
 * - `@sensitive` / `@required` / `@dynamic` to select by decorator (negate for the
 *   opposite, e.g. `!@dynamic` selects static items)
 * - `#tagname` to select items tagged via `@tag(tagname)`
 *
 * Structural rather than tied to `ConfigItem`: the CLI filters `ConfigItem`s (accurate only
 * *after* `resolveEnvValues()`), while code generation filters `TypeGenItemInfo`s — `isSensitive`/
 * `isRequired` on a bare `ConfigItem` are unreliable before resolution, so codegen must use its own
 * pre-resolution computation (`getTypeGenInfo()`) instead of a raw `ConfigItem` list.
 */
export type FilterableItem = {
  key: string;
  isSensitive: boolean;
  isRequired: boolean;
  isDynamic: boolean;
  tags: Array<string>;
};

// only the "positive" decorator of each pair gets a selector (like @sensitive
// not @public, @required not @optional) - negate for the opposite, e.g. `!@dynamic`
const DECORATOR_PREDICATES: Record<string, (item: FilterableItem) => boolean> = {
  sensitive: (item) => item.isSensitive,
  required: (item) => item.isRequired,
  dynamic: (item) => item.isDynamic,
};

/**
 * Valid tag names for `@tag(...)`, enforced when the decorator is processed so every tag stays
 * selectable via `#tagname`: the filter language reserves `,` (separator), leading `!`/`@`/`#`
 * (selector prefixes), whitespace (trimmed around selectors), and `*`/`?` (globs).
 */
export const TAG_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const TAG_NAME_RULES = 'Tag names must start with a letter or number, followed by letters, numbers, "_", or "-"';

type FilterToken = | { negate: boolean, kind: 'key', regex: RegExp }
  | { negate: boolean, kind: 'decorator', name: string }
  | { negate: boolean, kind: 'tag', tag: string };

function tokenMatches(item: FilterableItem, token: FilterToken): boolean {
  if (token.kind === 'key') return token.regex.test(item.key);
  if (token.kind === 'decorator') return DECORATOR_PREDICATES[token.name](item);
  return item.tags.includes(token.tag);
}

export class ParsedItemFilter {
  private tokens: Array<FilterToken>;

  /**
   * Whether this filter uses a `@sensitive`/`@required`/`@dynamic` decorator selector.
   *
   * These getters on a bare `ConfigItem` are only reliable after the item's *metadata* is
   * resolved (`ConfigItem.resolveMetadata()`) — they can be value-dependent (e.g.
   * `@required=forEnv(prod)`), unlike key/glob/tag selectors (knowable from the schema alone).
   * Callers scoping resolution to a filter use this to pick a strategy: key/tag-only filters
   * match immediately, while decorator filters resolve metadata first and then match exactly
   * (see `EnvGraph.resolveEnvValuesForFilter()`).
   */
  readonly usesDecoratorSelector: boolean;

  /** `label` prefixes any thrown `SchemaError` (e.g. `--filter` or `@generateTsTypes filter`) */
  constructor(filterStr: string, label: string) {
    const rawTokens = filterStr.split(',').map((t) => t.trim()).filter(Boolean);
    if (!rawTokens.length) {
      throw new SchemaError(`${label}: expected a comma-separated list of key names/globs, !negations, @decorators, or #tags`);
    }
    this.tokens = rawTokens.map((raw) => {
      let token = raw;
      let negate = false;
      if (token.startsWith('!')) {
        negate = true;
        token = token.slice(1).trim();
      }
      if (!token) throw new SchemaError(`${label}: empty item in "${raw}"`);

      if (token.startsWith('@')) {
        const name = token.slice(1);
        if (!(name in DECORATOR_PREDICATES)) {
          throw new SchemaError(`${label}: unknown decorator selector "@${name}"`, {
            tip: `Supported decorator selectors: ${Object.keys(DECORATOR_PREDICATES).map((n) => `@${n}`).join(', ')}`,
          });
        }
        return { negate, kind: 'decorator' as const, name };
      }
      if (token.startsWith('#')) {
        const tag = token.slice(1);
        if (!tag) throw new SchemaError(`${label}: empty tag in "${raw}"`);
        if (!TAG_NAME_REGEX.test(tag)) {
          throw new SchemaError(`${label}: invalid tag selector "#${tag}"`, { tip: TAG_NAME_RULES });
        }
        return { negate, kind: 'tag' as const, tag };
      }
      return { negate, kind: 'key' as const, regex: globToRegExp(token) };
    });
    this.usesDecoratorSelector = this.tokens.some((t) => t.kind === 'decorator');
  }

  /**
   * Whether a single item passes this filter: it matches at least one non-negated selector
   * (or there are none) and no negated selector. Decorator selectors read the item's computed
   * state, so this is only accurate once the item's metadata is resolved.
   */
  matches(item: FilterableItem): boolean {
    const positiveTokens = this.tokens.filter((t) => !t.negate);
    const included = positiveTokens.length
      ? positiveTokens.some((t) => tokenMatches(item, t))
      : true;
    if (!included) return false;
    return !this.tokens.some((t) => t.negate && tokenMatches(item, t));
  }

  /**
   * Evaluate the filter for an item BEFORE its decorator metadata is resolved, treating
   * decorator selectors as unknown. Returns `'no'` when the item cannot match regardless of
   * decorator state, `'yes'` when it matches regardless, else `'unknown'`. Filtered resolution
   * uses `'no'` to skip items entirely (not even resolving their metadata), matching how
   * key/glob/tag-only filters have always behaved.
   */
  preEvaluate(item: Pick<FilterableItem, 'key' | 'tags'>): 'yes' | 'no' | 'unknown' {
    let positiveCount = 0;
    let anyKnownPositiveMatch = false;
    let anyUnknownPositive = false;
    let anyUnknownNegative = false;
    for (const token of this.tokens) {
      if (token.kind === 'decorator') {
        if (token.negate) {
          anyUnknownNegative = true;
        } else {
          positiveCount++;
          anyUnknownPositive = true;
        }
        continue;
      }
      const match = tokenMatches(item as FilterableItem, token);
      if (token.negate) {
        if (match) return 'no';
      } else {
        positiveCount++;
        if (match) anyKnownPositiveMatch = true;
      }
    }
    const included = positiveCount === 0 ? true : anyKnownPositiveMatch;
    if (!included) return anyUnknownPositive ? 'unknown' : 'no';
    return anyUnknownNegative ? 'unknown' : 'yes';
  }

  /**
   * The set of config keys that pass this filter (see {@link matches}).
   */
  computeKeys(items: Array<FilterableItem>): Set<string> {
    const result = new Set<string>();
    for (const item of items) {
      if (this.matches(item)) result.add(item.key);
    }
    return result;
  }
}

/**
 * One-shot convenience: resolves a `filter=`/`--filter` string into the set of config keys that
 * pass it. Returns `undefined` when `filterStr` is unset, meaning "no filtering".
 */
export function computeFilteredKeys(
  items: Array<FilterableItem>,
  filterStr: string | undefined,
  label: string,
): Set<string> | undefined {
  if (!filterStr) return undefined;
  return new ParsedItemFilter(filterStr, label).computeKeys(items);
}
