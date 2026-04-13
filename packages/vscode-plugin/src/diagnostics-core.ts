import { isIP } from 'node:net';

import type { LineDocument } from './document-lines';
import { DECORATORS_BY_NAME } from './intellisense-catalog';

const DECORATOR_PATTERN = /@([A-Za-z][\w-]*)(?:\([^)]*\)|=[^\s#]+)?/g;
const MAX_MATCHES_PATTERN_LENGTH = 200;
const INCOMPATIBLE_DECORATOR_PAIRS = [
  ['required', 'optional'],
  ['sensitive', 'public'],
] as const;

/** Extract a regex pattern string from either a plain pattern or a `regex("pattern")` wrapper. */
function extractRegexPattern(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const wrapped = value.match(/^regex\("(.*)"\)$/s);
  if (wrapped) return wrapped[1];
  return value;
}

export type TypeInfo = {
  name: string;
  args: Array<string>;
  options: Record<string, string | boolean>;
};

export type DecoratorOccurrence = {
  name: string;
  line: number;
  start: number;
  end: number;
  isFunctionCall: boolean;
};

export type CoreDiagnostic = {
  line: number;
  start: number;
  end: number;
  message: string;
};

export function stripInlineComment(value: string) {
  let quote: '"' | '\'' | '' = '';

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value.trim();
}

export function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function isDynamicValue(value: string) {
  return /\$[A-Za-z_]/.test(value) || /^[A-Za-z][\w-]*\(/.test(value);
}

export function splitCommaSeparatedArgs(input: string) {
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

export function splitEnumArgs(input: string) {
  return splitCommaSeparatedArgs(input)
    .map((value) => unquote(value).trim())
    .filter(Boolean);
}

export function parseBooleanOption(value: string | boolean | undefined) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function parseTypeOptions(input: string) {
  return Object.fromEntries(
    splitCommaSeparatedArgs(input)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex < 0) return undefined;

        const key = part.slice(0, separatorIndex).trim();
        const rawValue = part.slice(separatorIndex + 1).trim();
        if (!key) return undefined;

        return [key, unquote(rawValue)] as const;
      })
      .filter(Boolean) as Array<readonly [string, string]>,
  );
}

export function getPrecedingCommentBlock(document: LineDocument, lineNumber: number) {
  const lines: Array<string> = [];

  for (let line = lineNumber - 1; line >= 0; line -= 1) {
    const text = document.lineAt(line).text.trim();
    if (!text.startsWith('#')) break;
    lines.unshift(text);
  }

  return lines;
}

function getDecoratorCommentText(lineText: string) {
  const match = lineText.match(/^\s*#\s*(@.*)$/);
  if (!match) return undefined;

  const commentText = match[1];

  return stripInlineComment(commentText);
}

export function getTypeInfoFromPrecedingComments(document: LineDocument, lineNumber: number) {
  const commentBlock = getPrecedingCommentBlock(document, lineNumber);

  for (let index = commentBlock.length - 1; index >= 0; index -= 1) {
    const decoratorComment = getDecoratorCommentText(commentBlock[index]);
    if (!decoratorComment) continue;

    const match = decoratorComment.match(/@type=([A-Za-z][\w-]*)(?:\((.*)\))?/);
    if (!match) continue;

    if (match[1] === 'enum') {
      return {
        name: match[1],
        args: splitEnumArgs(match[2] ?? ''),
        options: {},
      } satisfies TypeInfo;
    }

    return {
      name: match[1],
      args: [],
      options: parseTypeOptions(match[2] ?? ''),
    } satisfies TypeInfo;
  }

  return undefined;
}

export function getDecoratorOccurrences(lineText: string, lineNumber: number) {
  const occurrences: Array<DecoratorOccurrence> = [];
  const decoratorComment = getDecoratorCommentText(lineText);
  if (!decoratorComment) return occurrences;
  const decoratorCommentStart = lineText.indexOf(decoratorComment);

  for (const match of decoratorComment.matchAll(DECORATOR_PATTERN)) {
    const name = match[1];
    const start = decoratorCommentStart + (match.index ?? 0);
    const suffix = match[0].slice(name.length + 1);
    occurrences.push({
      name,
      line: lineNumber,
      start,
      end: start + match[0].length,
      isFunctionCall: suffix.startsWith('('),
    });
  }

  return occurrences;
}

export function createDecoratorDiagnostics(occurrences: Array<DecoratorOccurrence>) {
  const diagnostics: Array<CoreDiagnostic> = [];
  const seenCounts = new Map<string, number>();
  const reportedRanges = new Set<string>();

  for (const occurrence of occurrences) {
    const count = seenCounts.get(occurrence.name) ?? 0;
    seenCounts.set(occurrence.name, count + 1);

    const decorator = DECORATORS_BY_NAME[occurrence.name];
    const isRepeatableFunction = decorator?.isFunction ?? occurrence.isFunctionCall;
    if (!isRepeatableFunction && count >= 1) {
      diagnostics.push({
        line: occurrence.line,
        start: occurrence.start,
        end: occurrence.end,
        message: `@${occurrence.name} can only be used once in the same decorator block.`,
      });
    }
  }

  for (const [left, right] of INCOMPATIBLE_DECORATOR_PAIRS) {
    const conflicting = occurrences.filter((occurrence) => occurrence.name === left || occurrence.name === right);
    if (!conflicting.some((occurrence) => occurrence.name === left)) continue;
    if (!conflicting.some((occurrence) => occurrence.name === right)) continue;

    for (const occurrence of conflicting) {
      const rangeKey = `${occurrence.line}:${occurrence.start}:${occurrence.end}`;
      if (reportedRanges.has(rangeKey)) continue;
      reportedRanges.add(rangeKey);

      diagnostics.push({
        line: occurrence.line,
        start: occurrence.start,
        end: occurrence.end,
        message: `@${left} and @${right} cannot be used together.`,
      });
    }
  }

  return diagnostics;
}

function validateStringValue(value: string, options: TypeInfo['options']) {
  const allowEmpty = parseBooleanOption(options.allowEmpty);
  if (!allowEmpty && value.length === 0) return 'Value cannot be empty.';

  if (options.minLength && value.length < Number(options.minLength)) {
    return `Value must be at least ${options.minLength} characters long.`;
  }

  if (options.maxLength && value.length > Number(options.maxLength)) {
    return `Value must be at most ${options.maxLength} characters long.`;
  }

  if (options.isLength && value.length !== Number(options.isLength)) {
    return `Value must be exactly ${options.isLength} characters long.`;
  }

  if (typeof options.startsWith === 'string' && !value.startsWith(options.startsWith)) {
    return `Value must start with \`${options.startsWith}\`.`;
  }

  if (typeof options.endsWith === 'string' && !value.endsWith(options.endsWith)) {
    return `Value must end with \`${options.endsWith}\`.`;
  }

  if (typeof options.matches === 'string') {
    const pattern = extractRegexPattern(options.matches);
    if (!pattern || pattern.length > MAX_MATCHES_PATTERN_LENGTH) return undefined;

    try {
      const regex = new RegExp(pattern);
      if (!regex.test(value)) return `Value must match \`${options.matches}\`.`;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function validateNumberValue(value: string, options: TypeInfo['options']) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 'Value must be a valid number.';

  if (options.min !== undefined && numericValue < Number(options.min)) {
    return `Value must be greater than or equal to ${options.min}.`;
  }

  if (options.max !== undefined && numericValue > Number(options.max)) {
    return `Value must be less than or equal to ${options.max}.`;
  }

  if (options.isInt === 'true' || options.isInt === true) {
    if (!Number.isInteger(numericValue)) return 'Value must be an integer.';
  }

  if (options.isDivisibleBy !== undefined && numericValue % Number(options.isDivisibleBy) !== 0) {
    return `Value must be divisible by ${options.isDivisibleBy}.`;
  }

  if (options.precision !== undefined) {
    const [, decimals = ''] = value.split('.');
    if (decimals.length > Number(options.precision)) {
      return `Value must have at most ${options.precision} decimal places.`;
    }
  }

  return undefined;
}

function validateUrlValue(value: string, options: TypeInfo['options']) {
  const prependHttps = parseBooleanOption(options.prependHttps);
  const hasProtocol = /^https?:\/\//i.test(value);

  if (prependHttps && hasProtocol) {
    return 'URL should omit the protocol when prependHttps=true.';
  }

  if (!prependHttps && !hasProtocol) {
    return 'URL must include a protocol unless prependHttps=true.';
  }

  try {
    const url = new URL(prependHttps ? `https://${value}` : value);
    const allowedDomains = typeof options.allowedDomains === 'string'
      ? splitEnumArgs(options.allowedDomains)
      : [];

    if (allowedDomains.length > 0 && !allowedDomains.includes(url.host.toLowerCase())) {
      return `URL host must be one of: ${allowedDomains.join(', ')}.`;
    }

    if (parseBooleanOption(options.noTrailingSlash) && url.pathname.endsWith('/') && url.pathname !== '/') {
      return 'URL must not have a trailing slash.';
    }
  } catch {
    return 'Value must be a valid URL.';
  }

  if (typeof options.matches === 'string' && options.matches.length > 0) {
    const pattern = extractRegexPattern(options.matches);
    if (!pattern || pattern.length > MAX_MATCHES_PATTERN_LENGTH) return undefined;
    try {
      const regex = new RegExp(pattern);
      if (!regex.test(value)) return `URL must match \`${options.matches}\`.`;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function validateStaticValue(typeInfo: TypeInfo, value: string) {
  switch (typeInfo.name) {
    case 'string':
      return validateStringValue(value, typeInfo.options);
    case 'number':
      return validateNumberValue(value, typeInfo.options);
    case 'boolean':
      return /^(true|false|1|0|yes|no|on|off)$/i.test(value)
        ? undefined
        : 'Value must be a boolean.';
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? undefined
        : 'Value must be a valid email address.';
    case 'url':
      return validateUrlValue(value, typeInfo.options);
    case 'ip': {
      const version = Number(typeInfo.options.version);
      const detectedVersion = isIP(value);
      if (!detectedVersion) return 'Value must be a valid IPv4 or IPv6 address.';
      if ((version === 4 || version === 6) && detectedVersion !== version) {
        return `Value must be a valid IPv${version} address.`;
      }
      return undefined;
    }
    case 'port': {
      const numericValue = Number(value);
      if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 65535) {
        return 'Value must be a valid port number.';
      }
      if (typeInfo.options.min !== undefined && numericValue < Number(typeInfo.options.min)) {
        return `Port must be greater than or equal to ${typeInfo.options.min}.`;
      }
      if (typeInfo.options.max !== undefined && numericValue > Number(typeInfo.options.max)) {
        return `Port must be less than or equal to ${typeInfo.options.max}.`;
      }
      return undefined;
    }
    case 'semver':
      return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
        ? undefined
        : 'Value must be a valid semantic version.';
    case 'isoDate':
      return /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]*)?$/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'Value must be a valid ISO date.';
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? undefined
        : 'Value must be a valid UUID.';
    case 'md5':
      return /^[0-9a-f]{32}$/i.test(value)
        ? undefined
        : 'Value must be a valid MD5 hash.';
    case 'enum':
      return typeInfo.args.includes(value)
        ? undefined
        : `Value must be one of: ${typeInfo.args.join(', ')}.`;
    default:
      return undefined;
  }
}
