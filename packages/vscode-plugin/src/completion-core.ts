import type { DataTypeInfo, DecoratorInfo } from './intellisense-catalog';

type LineDocument = {
  lineCount: number;
  lineAt(line: number): { text: string };
};

const HEADER_SEPARATOR_PATTERN = /^\s*#\s*---+\s*$/;
const ENV_ASSIGNMENT_PATTERN = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;
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

function getFirstConfigItemLine(document: LineDocument) {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (ENV_ASSIGNMENT_PATTERN.test(document.lineAt(line).text)) return line;
  }

  return -1;
}

function getAttachedCommentBlockRange(document: LineDocument, firstConfigItemLine: number) {
  if (firstConfigItemLine <= 0) return undefined;

  const lastCommentLine = firstConfigItemLine - 1;
  const lastCommentText = document.lineAt(lastCommentLine).text.trim();
  if (!lastCommentText.startsWith('#') || HEADER_SEPARATOR_PATTERN.test(lastCommentText)) {
    return undefined;
  }

  let start = lastCommentLine;
  while (start > 0) {
    const previousText = document.lineAt(start - 1).text.trim();
    if (!previousText.startsWith('#') || HEADER_SEPARATOR_PATTERN.test(previousText)) break;
    start -= 1;
  }

  return { start, end: lastCommentLine };
}

export function getCommentScope(document: LineDocument, lineNumber: number) {
  const firstConfigItemLine = getFirstConfigItemLine(document);
  if (firstConfigItemLine === -1 || lineNumber >= firstConfigItemLine) return 'item';

  const attachedCommentBlock = getAttachedCommentBlockRange(document, firstConfigItemLine);
  if (attachedCommentBlock && lineNumber >= attachedCommentBlock.start && lineNumber <= attachedCommentBlock.end) {
    return 'item';
  }

  return 'header';
}

export function isInHeader(document: LineDocument, lineNumber: number) {
  return getCommentScope(document, lineNumber) === 'header';
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
