import { createHash } from 'node:crypto';
import _ from '@env-spec/utils/my-dash';
import type { ConfigItem } from '../env-graph/lib/config-item';

function shortHash(input: string) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function fromExampleTemplate(example: string): string {
  const lastUnderscoreIdx = example.lastIndexOf('_');
  if (lastUnderscoreIdx >= 0) {
    const prefix = example.slice(0, lastUnderscoreIdx + 1);
    const suffix = example.slice(lastUnderscoreIdx + 1).replace(/[A-Za-z0-9]/g, '0');
    return `${prefix}${suffix}`;
  }

  const firstDigitIdx = example.search(/\d/);
  if (firstDigitIdx > 0) {
    const prefix = example.slice(0, firstDigitIdx);
    const suffix = example.slice(firstDigitIdx).replace(/[A-Za-z0-9]/g, '0');
    return `${prefix}${suffix}`;
  }

  return example.replace(/[A-Za-z0-9]/g, '0');
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

export async function generateProxyPlaceholderForItem(
  item: ConfigItem,
  usedPlaceholders: Set<string>,
): Promise<string> {
  const placeholderDec = item.getDec('placeholder');
  if (placeholderDec) {
    const explicitPlaceholder = await placeholderDec.resolve();
    if (_.isString(explicitPlaceholder) && explicitPlaceholder.length > 0) {
      return ensureUnique(explicitPlaceholder, usedPlaceholders);
    }
  }

  const generatedByType = item.dataType?.generatePlaceholder(item.resolvedValue);
  if (_.isString(generatedByType) && generatedByType.length > 0) {
    return ensureUnique(generatedByType, usedPlaceholders);
  }

  const exampleDec = item.getDec('example');
  if (exampleDec) {
    const exampleValue = await exampleDec.resolve();
    if (_.isString(exampleValue) && exampleValue.length > 0) {
      return ensureUnique(fromExampleTemplate(exampleValue), usedPlaceholders);
    }
  }

  const fromType = fromTypeSettings(item);
  if (fromType) {
    return ensureUnique(fromType, usedPlaceholders);
  }

  return ensureUnique(buildFallbackPlaceholder(item.key), usedPlaceholders);
}
