import { createHash } from 'node:crypto';
import _ from '@env-spec/utils/my-dash';
import type { ConfigItem } from '../env-graph/lib/config-item';

function shortHash(input: string) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * A unique, format-safe seed for an item's placeholder: lowercase alphanumerics
 * and hyphens only, so it embeds cleanly in a hostname / email local-part / etc.
 * The key hash keeps distinct items distinct (required so wire scrubbing can't
 * confuse two secrets).
 */
function buildPlaceholderSeed(itemKey: string): string {
  const slug = itemKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `vlk-placeholder-${slug}-${shortHash(itemKey)}`;
}

/**
 * Best-effort placeholder honoring a string `@type`'s startsWith/endsWith/isLength
 * settings, while embedding the unique seed so distinct items stay distinct.
 * Returns undefined when the item has none of those settings.
 */
function fromTypeSettings(item: ConfigItem, seed: string): string | undefined {
  const typeDecParsedValue = item.getDec('type')?.parsedDecorator.value;
  if (!typeDecParsedValue || !('simplifiedArgs' in typeDecParsedValue)) return undefined;

  const simplifiedArgs = typeDecParsedValue.simplifiedArgs;
  if (!_.isPlainObject(simplifiedArgs)) return undefined;

  const startsWith = _.isString(simplifiedArgs.startsWith) ? simplifiedArgs.startsWith : '';
  const endsWith = _.isString(simplifiedArgs.endsWith) ? simplifiedArgs.endsWith : '';
  const isLength = _.isNumber(simplifiedArgs.isLength) ? simplifiedArgs.isLength : undefined;

  if (!startsWith && !endsWith && isLength === undefined) return undefined;

  if (isLength !== undefined) {
    if (isLength <= 0) return '';
    const fixedLen = startsWith.length + endsWith.length;
    if (fixedLen >= isLength) return `${startsWith}${endsWith}`.slice(0, isLength);
    const bodyLen = isLength - fixedLen;
    // Fill the bounded middle with hash hex (not the seed prefix, which is constant
    // across items) so length-capped placeholders stay unique. 64 hex chars cover
    // any realistic length; pad only in the pathological case.
    const hex = createHash('sha256').update(seed).digest('hex');
    const body = hex.length >= bodyLen ? hex.slice(0, bodyLen) : `${hex}${'0'.repeat(bodyLen - hex.length)}`;
    return `${startsWith}${body}${endsWith}`;
  }

  return `${startsWith}${seed}${endsWith}`;
}

function buildFallbackPlaceholder(itemKey: string): string {
  return `vlk_placeholder_${itemKey}_${shortHash(itemKey)}`;
}

function ensureUnique(placeholder: string, usedPlaceholders: Set<string>) {
  if (!usedPlaceholders.has(placeholder)) {
    usedPlaceholders.add(placeholder);
    return placeholder;
  }

  let i = 1;
  while (true) {
    const next = `${placeholder}_${i}`;
    if (!usedPlaceholders.has(next)) {
      usedPlaceholders.add(next);
      return next;
    }
    i += 1;
  }
}

export type GeneratedProxyPlaceholder = {
  placeholder: string;
  /**
   * True when we fell back to the generic `vlk_placeholder_*` form because the
   * item gave us no format hint. That placeholder will fail any SDK that
   * validates key shape (e.g. an `sk-…` prefix check) at client construction,
   * so callers should warn the author to add an explicit `@placeholder` or a
   * data type that knows the real format.
   */
  isGenericFallback: boolean;
};

/**
 * Derive a proxy placeholder for an item, in priority order:
 *  1. explicit `@placeholder` — the author's exact value
 *  2. data-type `generatePlaceholder(seed)` — a valid-and-unique form for types
 *     that have one (url/email/uuid/md5, …); most likely to pass SDK validation
 *  3. `@type` startsWith/endsWith/isLength constraints — honors the declared
 *     string rules while staying unique
 *  4. generic fallback — guaranteed-unique but format-agnostic (flagged)
 *
 * All forms embed a per-item unique seed so distinct secrets never share a
 * placeholder (wire scrubbing relies on that). Deriving from `@example` was
 * intentionally removed: a documentation field shouldn't double as a functional,
 * validation-critical placeholder.
 */
export async function generateProxyPlaceholderForItem(
  item: ConfigItem,
  usedPlaceholders: Set<string>,
): Promise<GeneratedProxyPlaceholder> {
  const placeholderDec = item.getDec('placeholder');
  if (placeholderDec) {
    const explicitPlaceholder = await placeholderDec.resolve();
    if (_.isString(explicitPlaceholder) && explicitPlaceholder.length > 0) {
      return { placeholder: ensureUnique(explicitPlaceholder, usedPlaceholders), isGenericFallback: false };
    }
  }

  const seed = buildPlaceholderSeed(item.key);

  const generatedByType = item.dataType?.generatePlaceholder(seed);
  if (_.isString(generatedByType) && generatedByType.length > 0) {
    return { placeholder: ensureUnique(generatedByType, usedPlaceholders), isGenericFallback: false };
  }

  const fromType = fromTypeSettings(item, seed);
  if (fromType) {
    return { placeholder: ensureUnique(fromType, usedPlaceholders), isGenericFallback: false };
  }

  return { placeholder: ensureUnique(buildFallbackPlaceholder(item.key), usedPlaceholders), isGenericFallback: true };
}
