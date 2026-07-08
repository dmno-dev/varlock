import { SchemaError } from './errors';
import { globToRegExp } from './glob';

/**
 * Shared item-selection language used by the CLI `--filter` flag (`varlock load`/`run`) and the
 * `filter=` arg on code-generation decorators (e.g. `@generateTsTypes(filter=#billing)`). A comma-
 * separated list of selectors:
 * - a key name or glob (`STRIPE_*`) to select matching items
 * - `!selector` to negate any of the below (e.g. `!DEBUG_*`)
 * - `@sensitive` / `@required` to select by decorator
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
  tags: Array<string>;
};

const DECORATOR_PREDICATES: Record<string, (item: FilterableItem) => boolean> = {
  sensitive: (item) => item.isSensitive,
  required: (item) => item.isRequired,
};

type FilterToken = | { negate: boolean, kind: 'key', pattern: string }
  | { negate: boolean, kind: 'decorator', name: string }
  | { negate: boolean, kind: 'tag', tag: string };

function parseItemFilter(filterStr: string, label: string): Array<FilterToken> {
  const rawTokens = filterStr.split(',').map((t) => t.trim()).filter(Boolean);
  if (!rawTokens.length) {
    throw new SchemaError(`${label}: expected a comma-separated list of key names/globs, !negations, @decorators, or #tags`);
  }
  return rawTokens.map((raw) => {
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
      return { negate, kind: 'decorator', name };
    }
    if (token.startsWith('#')) {
      const tag = token.slice(1);
      if (!tag) throw new SchemaError(`${label}: empty tag in "${raw}"`);
      return { negate, kind: 'tag', tag };
    }
    return { negate, kind: 'key', pattern: token };
  });
}

function tokenMatches(item: FilterableItem, token: FilterToken): boolean {
  if (token.kind === 'key') return globToRegExp(token.pattern).test(item.key);
  if (token.kind === 'decorator') return DECORATOR_PREDICATES[token.name](item);
  return item.tags.includes(token.tag);
}

/**
 * Resolves a `filter=`/`--filter` string into the set of config keys that pass it.
 *
 * An item passes when it matches at least one non-negated selector (or there are none) and no
 * negated selector. Returns `undefined` when `filterStr` is unset, meaning "no filtering".
 * `label` prefixes any thrown `SchemaError` (e.g. `--filter` or `@generateTsTypes filter`).
 */
export function computeFilteredKeys(
  items: Array<FilterableItem>,
  filterStr: string | undefined,
  label: string,
): Set<string> | undefined {
  if (!filterStr) return undefined;
  const tokens = parseItemFilter(filterStr, label);
  const positiveTokens = tokens.filter((t) => !t.negate);
  const negativeTokens = tokens.filter((t) => t.negate);

  const result = new Set<string>();
  for (const item of items) {
    const included = positiveTokens.length
      ? positiveTokens.some((t) => tokenMatches(item, t))
      : true;
    if (!included) continue;
    if (negativeTokens.some((t) => tokenMatches(item, t))) continue;
    result.add(item.key);
  }
  return result;
}
