import { createHash } from 'node:crypto';
import _ from '@env-spec/utils/my-dash';
import type { ConfigItem } from '../env-graph/lib/config-item';

function shortHash(input: string) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function fromTypeSettings(item: ConfigItem): string | undefined {
  const typeDecParsedValue = item.getDec('type')?.parsedDecorator.value;
  if (!typeDecParsedValue || !('simplifiedArgs' in typeDecParsedValue)) return undefined;

  const simplifiedArgs = typeDecParsedValue.simplifiedArgs;
  if (!_.isPlainObject(simplifiedArgs)) return undefined;

  const startsWith = _.isString(simplifiedArgs.startsWith)
    ? simplifiedArgs.startsWith
    : '';
  const isLength = _.isNumber(simplifiedArgs.isLength)
    ? simplifiedArgs.isLength
    : undefined;

  if (!startsWith && !isLength) return undefined;

  if (isLength !== undefined) {
    if (isLength <= 0) return '';
    if (startsWith.length >= isLength) return startsWith.slice(0, isLength);
    return `${startsWith}${'0'.repeat(isLength - startsWith.length)}`;
  }

  return `${startsWith}0000000000000000`;
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
 *  2. data-type `generatePlaceholder()` — the blessed source: it encodes the
 *     provider's real format, so it's the one most likely to pass SDK validation
 *  3. `@type` startsWith/isLength constraints — deterministic, but only honors
 *     the declared validation rules, which may not match the SDK's real checks
 *  4. generic fallback — guaranteed-unique but format-agnostic (flagged)
 *
 * Deriving from `@example` was intentionally removed: a documentation field
 * shouldn't double as a functional, validation-critical placeholder.
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

  const generatedByType = item.dataType?.generatePlaceholder(item.resolvedValue);
  if (_.isString(generatedByType) && generatedByType.length > 0) {
    return { placeholder: ensureUnique(generatedByType, usedPlaceholders), isGenericFallback: false };
  }

  const fromType = fromTypeSettings(item);
  if (fromType) {
    return { placeholder: ensureUnique(fromType, usedPlaceholders), isGenericFallback: false };
  }

  return { placeholder: ensureUnique(buildFallbackPlaceholder(item.key), usedPlaceholders), isGenericFallback: true };
}
