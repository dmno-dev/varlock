import { SemanticTokensBuilder, type SemanticTokens } from 'vscode-languageserver';

export const SEMANTIC_TOKENS_LEGEND = {
  tokenTypes: [
    'decorator',
    'type',
    'property',
    'variable',
    'function',
    'string',
    'number',
    'regexp',
    'keyword',
    'operator',
  ],
  tokenModifiers: [],
};

type SemanticTokenType = typeof SEMANTIC_TOKENS_LEGEND.tokenTypes[number];

const TOKEN_TYPE_INDEX = new Map(
  SEMANTIC_TOKENS_LEGEND.tokenTypes.map((tokenType, index) => [tokenType, index]),
);
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_-]*/y;
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/y;

export function createSemanticTokens(lines: Array<string>): SemanticTokens {
  const builder = new SemanticTokensBuilder();

  lines.forEach((line, lineNumber) => {
    addDecoratorCommentTokens(builder, line, lineNumber);
  });

  return builder.build();
}

function addDecoratorCommentTokens(builder: SemanticTokensBuilder, line: string, lineNumber: number) {
  const hashIndex = line.indexOf('#');
  if (hashIndex < 0) return;

  let index = hashIndex + 1;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  if (line[index] !== '@') return;

  const end = getDecoratorCommentEnd(line, index);
  let currentDecorator: string | undefined;
  let expectTypeValue = false;
  let parenDepth = 0;

  while (index < end) {
    const char = line[index];

    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }

    if (char === '@') {
      const start = index;
      index += 1;
      const name = readIdentifier(line, index, end);
      if (!name) continue;

      index += name.length;
      currentDecorator = name;
      expectTypeValue = false;
      pushToken(builder, lineNumber, start, index - start, 'decorator');
      continue;
    }

    if (isOperator(char)) {
      pushToken(builder, lineNumber, index, 1, 'operator');
      if (char === '(') parenDepth += 1;
      if (char === ')') parenDepth = Math.max(parenDepth - 1, 0);
      if (char === '=' && currentDecorator === 'type' && parenDepth === 0) expectTypeValue = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === '\'') {
      const start = index;
      index = readQuoted(line, index, end);
      pushToken(builder, lineNumber, start, index - start, 'string');
      expectTypeValue = false;
      continue;
    }

    if (char === '/' && index + 1 < end) {
      const regexEnd = readRegexLiteral(line, index, end);
      if (regexEnd > index + 1) {
        pushToken(builder, lineNumber, index, regexEnd - index, 'regexp');
        index = regexEnd;
        continue;
      }
    }

    if (char === '$') {
      const start = index;
      index = readReference(line, index, end);
      pushToken(builder, lineNumber, start, index - start, 'variable');
      continue;
    }

    const number = readNumber(line, index, end);
    if (number) {
      pushToken(builder, lineNumber, index, number.length, 'number');
      index += number.length;
      continue;
    }

    const identifier = readIdentifier(line, index, end);
    if (identifier) {
      const type = classifyIdentifier(line, index, end, identifier, parenDepth, expectTypeValue);
      pushToken(builder, lineNumber, index, identifier.length, type);
      index += identifier.length;
      expectTypeValue = false;
      continue;
    }

    index += 1;
  }
}

function classifyIdentifier(
  line: string,
  index: number,
  end: number,
  identifier: string,
  parenDepth: number,
  expectTypeValue: boolean,
): SemanticTokenType {
  if (expectTypeValue) return 'type';
  if (identifier === 'true' || identifier === 'false' || identifier === 'infer') return 'keyword';

  const nextChar = nextNonWhitespaceCharacter(line, index + identifier.length, end);
  if (nextChar === '(') return 'function';
  if (parenDepth > 0 && nextChar === '=') return 'property';

  return 'string';
}

function getDecoratorCommentEnd(line: string, start: number) {
  let quote: '"' | '\'' | undefined;

  for (let index = start; index < line.length; index += 1) {
    const char = line[index];

    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (char === '#' && index > start && /\s/.test(line[index - 1])) {
      return index;
    }
  }

  return line.length;
}

function readIdentifier(line: string, index: number, end: number) {
  IDENTIFIER_PATTERN.lastIndex = index;
  const match = IDENTIFIER_PATTERN.exec(line.slice(0, end));
  return match?.index === index ? match[0] : undefined;
}

function readNumber(line: string, index: number, end: number) {
  NUMBER_PATTERN.lastIndex = index;
  const match = NUMBER_PATTERN.exec(line.slice(0, end));
  return match?.index === index ? match[0] : undefined;
}

function readQuoted(line: string, start: number, end: number) {
  const quote = line[start];
  let index = start + 1;

  while (index < end) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }

    index += 1;
    if (line[index - 1] === quote) break;
  }

  return index;
}

function readRegexLiteral(line: string, start: number, end: number) {
  let index = start + 1;

  while (index < end) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }

    index += 1;
    if (line[index - 1] === '/') break;
  }

  while (index < end && /[dgimsuvy]/.test(line[index])) index += 1;
  return index;
}

function readReference(line: string, start: number, end: number) {
  if (line[start + 1] === '{') {
    let index = start + 2;
    while (index < end && /[A-Za-z0-9_:-]/.test(line[index])) index += 1;
    return line[index] === '}' ? index + 1 : index;
  }

  let index = start + 1;
  while (index < end && /[A-Za-z0-9_]/.test(line[index])) index += 1;
  return index;
}

function nextNonWhitespaceCharacter(line: string, index: number, end: number) {
  while (index < end && /\s/.test(line[index])) index += 1;
  return line[index];
}

function isOperator(char: string) {
  return char === '=' || char === '(' || char === ')' || char === ',';
}

function pushToken(
  builder: SemanticTokensBuilder,
  line: number,
  start: number,
  length: number,
  type: SemanticTokenType,
) {
  if (length <= 0) return;

  const tokenType = TOKEN_TYPE_INDEX.get(type);
  if (tokenType === undefined) return;

  builder.push(line, start, length, tokenType, 0);
}
