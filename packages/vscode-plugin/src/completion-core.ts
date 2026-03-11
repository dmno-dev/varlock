import type { DataTypeInfo, DecoratorInfo } from './intellisense-catalog';

type LineDocument = {
  lineCount: number;
  lineAt(line: number): { text: string };
};

const HEADER_SEPARATOR_PATTERN = /^\s*#\s*---+\s*$/;
const DECORATOR_PATTERN = /@([A-Za-z][\w-]*)/g;
const INCOMPATIBLE_DECORATORS = new Map<string, Set<string>>([
  ['required', new Set(['optional'])],
  ['optional', new Set(['required'])],
  ['sensitive', new Set(['public'])],
  ['public', new Set(['sensitive'])],
]);

function splitArgs(input: string) {
  const parts: Array<string> = [];
  let current = '';
  let quote: '"' | '\'' | '' = '';
  let depth = 0;

  for (const char of input) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')') {
      depth = Math.max(depth - 1, 0);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const value = current.trim();
      if (value) parts.push(value);
      current = '';
      continue;
    }

    current += char;
  }

  const value = current.trim();
  if (value) parts.push(value);
  return parts;
}

export function isInHeader(document: LineDocument, lineNumber: number) {
  for (let line = lineNumber; line >= 0; line -= 1) {
    if (HEADER_SEPARATOR_PATTERN.test(document.lineAt(line).text)) return false;
  }
  return true;
}

export function getExistingDecoratorNames(
  document: LineDocument,
  lineNumber: number,
  commentPrefix: string,
) {
  const names = new Set<string>();

  for (let line = lineNumber - 1; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (!text.startsWith('#')) break;
    for (const match of text.matchAll(DECORATOR_PATTERN)) {
      names.add(match[1]);
    }
  }

  for (const match of commentPrefix.matchAll(DECORATOR_PATTERN)) {
    names.add(match[1]);
  }

  return names;
}

export function filterAvailableDecorators(
  decorators: Array<DecoratorInfo>,
  existingDecoratorNames: Set<string>,
) {
  return decorators.filter((decorator) => {
    if (!decorator.isFunction && existingDecoratorNames.has(decorator.name)) return false;

    const incompatible = INCOMPATIBLE_DECORATORS.get(decorator.name);
    if (!incompatible) return true;

    return ![...incompatible].some((name) => existingDecoratorNames.has(name));
  });
}

export function splitEnumArgs(input: string) {
  return splitArgs(input).map((value) => value.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean);
}

export function getEnumValuesFromPrecedingComments(document: LineDocument, lineNumber: number) {
  for (let line = lineNumber - 1; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (!text.startsWith('#')) break;

    const match = text.match(/@type=enum\((.*)\)/);
    if (match) return splitEnumArgs(match[1]);
  }

  return undefined;
}

export function getTypeOptionDataType(dataTypes: Array<DataTypeInfo>, commentPrefix: string) {
  const match = commentPrefix.match(/(^|\s)@type=([A-Za-z][\w-]*)\([^#)]*$/);
  if (!match) return undefined;
  return dataTypes.find((dataType) => dataType.name === match[2]);
}
