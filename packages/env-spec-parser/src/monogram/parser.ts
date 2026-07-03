import { createParser } from 'monogram/src/gen-parser';
import {
  ParsedEnvSpecArrayLiteral,
  ParsedEnvSpecBlankLine,
  ParsedEnvSpecComment,
  ParsedEnvSpecCommentBlock,
  ParsedEnvSpecConfigItem,
  ParsedEnvSpecDecorator,
  ParsedEnvSpecDecoratorComment,
  ParsedEnvSpecDivider,
  ParsedEnvSpecFile,
  ParsedEnvSpecFunctionArgs,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecObjectLiteral,
  ParsedEnvSpecStaticValue,
} from '../classes';
import { envSpecGrammar } from './env-spec-grammar';

type CstNode = {
  rule: string;
  children: Array<CstNode | CstLeaf>;
  offset: number;
  end: number;
};

type CstLeaf = {
  tokenType: string;
  offset: number;
  end: number;
};

const monogramParser = createParser(envSpecGrammar);
type ParsedCommentNode = ParsedEnvSpecComment | ParsedEnvSpecDecoratorComment;

function isNode(x: CstNode | CstLeaf): x is CstNode {
  return 'rule' in x;
}

function isLeaf(x: CstNode | CstLeaf): x is CstLeaf {
  return 'tokenType' in x;
}

function leafText(source: string, leaf: CstLeaf): string {
  return source.slice(leaf.offset, leaf.end);
}

function findFirstLeaf(node: CstNode, tokenType: string): CstLeaf | undefined {
  return node.children.find((child) => isLeaf(child) && child.tokenType === tokenType) as CstLeaf | undefined;
}

function findFirstNode(node: CstNode, rule: string): CstNode | undefined {
  return node.children.find((child) => isNode(child) && child.rule === rule) as CstNode | undefined;
}

function findDirectNodes(node: CstNode, rule: string): Array<CstNode> {
  return node.children.filter((child) => isNode(child) && child.rule === rule) as Array<CstNode>;
}

function findNodes(node: CstNode, rule: string): Array<CstNode> {
  const out: Array<CstNode> = [];
  for (const child of node.children) {
    if (!isNode(child)) continue;
    if (child.rule === rule) out.push(child);
    out.push(...findNodes(child, rule));
  }
  return out;
}

function validateDecoratorMultiline(input: string) {
  const normalized = input.replaceAll('\r\n', '\n');
  if (!normalized.includes('\n')) return;

  const lines = normalized.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const continuation = lines[i] ?? '';
    // every continuation line must be `#`-prefixed; content after the marker may
    // itself start with `#` (a commented-out entry) — that is valid
    const match = continuation.match(/^[ \t]*#([ \t]*)([\s\S]*)$/);
    if (!match) throw new Error('Malformed multiline decorator');
  }
}

function parseStaticValue(rawValue: string): ParsedEnvSpecStaticValue {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"""') && trimmed.endsWith('"""')) {
    if (!trimmed.includes('\n')) throw new Error('Triple-quoted strings must be multiline');
    return new ParsedEnvSpecStaticValue({ rawValue: trimmed, quote: '"""', isMultiLine: true });
  }
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    if (!trimmed.includes('\n')) throw new Error('Triple-backtick strings must be multiline');
    return new ParsedEnvSpecStaticValue({ rawValue: trimmed, quote: '```', isMultiLine: true });
  }
  if (/^"(?:\\.|[^"\\])*"$/.test(trimmed)) {
    return new ParsedEnvSpecStaticValue({ rawValue: trimmed, quote: '"' });
  }
  if (/^'(?:\\.|[^'\\])*'$/.test(trimmed)) {
    return new ParsedEnvSpecStaticValue({ rawValue: trimmed, quote: "'" });
  }
  if (/^`(?:\\.|[^`\\])*`$/.test(trimmed)) {
    return new ParsedEnvSpecStaticValue({ rawValue: trimmed, quote: '`' });
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')) {
    throw new Error('Unterminated quoted string');
  }
  return new ParsedEnvSpecStaticValue({ rawValue });
}

function nodeText(source: string, node: CstNode): string {
  return source.slice(node.offset, node.end);
}

function parseFunctionArgValueNode(
  source: string,
  valueNode: CstNode,
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  const literalNode = findNodes(valueNode, 'ObjectLiteral')[0] ?? findNodes(valueNode, 'ArrayLiteral')[0];
  if (literalNode && literalNode.offset === valueNode.offset && literalNode.end === valueNode.end) {
    // eslint-disable-next-line no-use-before-define
    return parseLiteralNode(source, literalNode);
  }
  const nestedCallNode = findNodes(valueNode, 'FunctionCall')[0];
  if (nestedCallNode && nestedCallNode.offset === valueNode.offset && nestedCallNode.end === valueNode.end) {
    // eslint-disable-next-line no-use-before-define
    return parseFunctionCallNode(source, nestedCallNode);
  }
  return parseStaticValue(nodeText(source, valueNode));
}

function parseFunctionArgNode(
  source: string,
  argNode: CstNode,
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecKeyValuePair
  | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  const keyValueNode = findFirstNode(argNode, 'FunctionArgKeyValue');
  if (keyValueNode) {
    const keyLeaf = findFirstLeaf(keyValueNode, 'ASSIGN_KEY');
    const valueNode = findFirstNode(keyValueNode, 'FunctionArgValue');
    if (!keyLeaf || !valueNode) throw new Error('Malformed function argument key/value');
    return new ParsedEnvSpecKeyValuePair({
      key: leafText(source, keyLeaf),
      val: parseFunctionArgValueNode(source, valueNode),
    });
  }

  const valueNode = findFirstNode(argNode, 'FunctionArgValue');
  if (!valueNode) throw new Error('Malformed function argument');
  return parseFunctionArgValueNode(source, valueNode);
}

function parseFunctionArgsNode(source: string, argsNode: CstNode): ParsedEnvSpecFunctionArgs {
  const chunkNodes = findDirectNodes(argsNode, 'FunctionArgChunk');
  const argNodes = chunkNodes
    .map((chunkNode) => findFirstNode(chunkNode, 'FunctionArg'))
    .filter((argNode): argNode is CstNode => !!argNode);
  const values = argNodes.map((argNode) => parseFunctionArgNode(source, argNode));
  return new ParsedEnvSpecFunctionArgs({ values });
}

// ── object/array literal mapping (value + decorator context share CST shapes) ──

function parseObjectLiteralNode(source: string, node: CstNode): ParsedEnvSpecObjectLiteral {
  const isDecorator = node.rule === 'DecoratorObjectLiteral';
  const chunkRule = isDecorator ? 'DecoratorObjectLiteralEntryChunk' : 'ObjectLiteralEntryChunk';
  const entryRule = isDecorator ? 'DecoratorFunctionArgKeyValue' : 'ObjectLiteralEntry';
  const values = findDirectNodes(node, chunkRule).flatMap((chunkNode) => {
    const entryNode = findFirstNode(chunkNode, entryRule);
    if (!entryNode) return [];
    let keyLeaf = findFirstLeaf(entryNode, 'ASSIGN_KEY');
    if (!keyLeaf && isDecorator) {
      const keyNode = findFirstNode(entryNode, 'DecoratorArgKey');
      keyLeaf = keyNode ? (findFirstLeaf(keyNode, 'ASSIGN_KEY') ?? findFirstLeaf(keyNode, 'IDENT')) : undefined;
    }
    const valueNode = isDecorator
      ? findFirstNode(entryNode, 'DecoratorFunctionArgValue')
      : findFirstNode(entryNode, 'FunctionArgValue');
    if (!keyLeaf || !valueNode) throw new Error('Malformed object literal entry');
    return [
      new ParsedEnvSpecKeyValuePair({
        key: leafText(source, keyLeaf),
        val: isDecorator
        // eslint-disable-next-line no-use-before-define
          ? parseDecoratorFunctionArgValueNode(source, valueNode)
          : parseFunctionArgValueNode(source, valueNode),
      }),
    ];
  });
  return new ParsedEnvSpecObjectLiteral({ values });
}

function parseArrayLiteralNode(source: string, node: CstNode): ParsedEnvSpecArrayLiteral {
  const isDecorator = node.rule === 'DecoratorArrayLiteral';
  const chunkRule = isDecorator ? 'DecoratorArrayLiteralElementChunk' : 'ArrayLiteralElementChunk';
  const valueRule = isDecorator ? 'DecoratorFunctionArgValue' : 'FunctionArgValue';
  const values = findDirectNodes(node, chunkRule).flatMap((chunkNode) => {
    const valueNode = findFirstNode(chunkNode, valueRule);
    if (!valueNode) return [];
    return [
      isDecorator
      // eslint-disable-next-line no-use-before-define
        ? parseDecoratorFunctionArgValueNode(source, valueNode)
        : parseFunctionArgValueNode(source, valueNode),
    ];
  });
  return new ParsedEnvSpecArrayLiteral({ values });
}

function parseLiteralNode(
  source: string,
  node: CstNode,
): ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  if (node.rule === 'ObjectLiteral' || node.rule === 'DecoratorObjectLiteral') {
    return parseObjectLiteralNode(source, node);
  }
  return parseArrayLiteralNode(source, node);
}

function parseFunctionCallNode(source: string, functionCallNode: CstNode): ParsedEnvSpecFunctionCall {
  const nameLeaf = findFirstLeaf(functionCallNode, 'FUNCTION_NAME');
  const argsNode = findFirstNode(functionCallNode, 'FunctionArgs');
  if (!nameLeaf || !argsNode) throw new Error('Malformed function call');

  return new ParsedEnvSpecFunctionCall({
    name: leafText(source, nameLeaf),
    args: parseFunctionArgsNode(source, argsNode),
  });
}

function parseDecoratorFunctionArgValueNode(
  source: string,
  valueNode: CstNode,
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  const literalNode = findFirstNode(valueNode, 'DecoratorObjectLiteral')
    ?? findFirstNode(valueNode, 'DecoratorArrayLiteral');
  if (literalNode) {
    return parseLiteralNode(source, literalNode);
  }
  const nestedCallNode = findFirstNode(valueNode, 'DecoratorFunctionCall');
  if (nestedCallNode) {
    // eslint-disable-next-line no-use-before-define
    return parseDecoratorFunctionCallNode(source, nestedCallNode);
  }
  return parseStaticValue(nodeText(source, valueNode));
}

function parseDecoratorFunctionArgNode(
  source: string,
  argNode: CstNode,
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecKeyValuePair
  | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  const keyValueNode = findFirstNode(argNode, 'DecoratorFunctionArgKeyValue');
  if (keyValueNode) {
    const keyNode = findFirstNode(keyValueNode, 'DecoratorArgKey');
    const keyLeaf = keyNode
      ? (findFirstLeaf(keyNode, 'ASSIGN_KEY') ?? findFirstLeaf(keyNode, 'IDENT'))
      : undefined;
    const valueNode = findFirstNode(keyValueNode, 'DecoratorFunctionArgValue');
    if (!keyLeaf || !valueNode) throw new Error('Malformed decorator function argument key/value');
    return new ParsedEnvSpecKeyValuePair({
      key: leafText(source, keyLeaf),
      val: parseDecoratorFunctionArgValueNode(source, valueNode),
    });
  }

  const valueNode = findFirstNode(argNode, 'DecoratorFunctionArgValue');
  if (!valueNode) throw new Error('Malformed decorator function argument');
  return parseDecoratorFunctionArgValueNode(source, valueNode);
}

function parseDecoratorFunctionArgsNode(
  source: string,
  argsNode: CstNode,
  options?: { validateRaw?: boolean },
): ParsedEnvSpecFunctionArgs {
  const validateRaw = options?.validateRaw ?? true;

  const rawArgs = nodeText(source, argsNode);
  if (validateRaw) validateDecoratorMultiline(rawArgs);

  const chunkNodes = findDirectNodes(argsNode, 'DecoratorFunctionArgChunk').sort((a, b) => a.offset - b.offset);

  const argNodes = chunkNodes
    .map((chunkNode) => findFirstNode(chunkNode, 'DecoratorFunctionArg'))
    .filter((argNode): argNode is CstNode => !!argNode);

  const values = argNodes.map((argNode) => parseDecoratorFunctionArgNode(source, argNode));
  return new ParsedEnvSpecFunctionArgs({ values });
}

function parseDecoratorFunctionCallNode(
  source: string,
  functionCallNode: CstNode,
): ParsedEnvSpecFunctionCall {
  const nameLeaf = findFirstLeaf(functionCallNode, 'FUNCTION_NAME');
  const argsNode = findFirstNode(functionCallNode, 'DecoratorFunctionArgs');
  if (!nameLeaf || !argsNode) throw new Error('Malformed decorator function call');
  return new ParsedEnvSpecFunctionCall({
    name: leafText(source, nameLeaf),
    args: parseDecoratorFunctionArgsNode(source, argsNode),
  });
}

function parseDecoratorValueNode(
  source: string,
  valueNode: CstNode,
): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral {
  const literalNode = findFirstNode(valueNode, 'DecoratorObjectLiteral')
    ?? findFirstNode(valueNode, 'DecoratorArrayLiteral');
  if (literalNode) {
    return parseLiteralNode(source, literalNode);
  }
  const functionCallNode = findFirstNode(valueNode, 'DecoratorFunctionCall');
  if (functionCallNode) {
    return parseDecoratorFunctionCallNode(source, functionCallNode);
  }
  return parseStaticValue(nodeText(source, valueNode));
}

function parseValueNode(source: string, valueNode: CstNode): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall {
  const functionCallNode = findFirstNode(valueNode, 'FunctionCall');
  if (functionCallNode) {
    return parseFunctionCallNode(source, functionCallNode);
  }
  return parseStaticValue(nodeText(source, valueNode));
}

function findPoundLeaf(source: string, node: CstNode): CstLeaf | undefined {
  return node.children.find(
    (child) => isLeaf(child)
      && ((child.tokenType === '$punct' && leafText(source, child) === '#') || child.tokenType === 'HASH'),
  ) as CstLeaf | undefined;
}

function parseDecoratorFromNode(
  source: string,
  node: CstNode,
): ParsedEnvSpecDecorator {
  const nameLeaf = findFirstLeaf(node, 'DEC_NAME');
  if (!nameLeaf) throw new Error('Malformed decorator');
  const name = leafText(source, nameLeaf).slice(1);

  const argsNode = findNodes(node, 'DecoratorFunctionArgs')[0];
  const valueNode = findNodes(node, 'DecoratorValue')[0];
  const suffix = source.slice(nameLeaf.end, node.end).trimStart();
  const isExplicitAssign = suffix.startsWith('=');

  if (isExplicitAssign && !valueNode) {
    throw new Error('Expected decorator value');
  }

  let value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs
    | ParsedEnvSpecObjectLiteral | ParsedEnvSpecArrayLiteral | undefined;
  let isBareFnCall = false;

  if (argsNode && !isExplicitAssign) {
    value = parseDecoratorFunctionArgsNode(source, argsNode);
    isBareFnCall = true;
  } else if (valueNode) {
    value = parseDecoratorValueNode(source, valueNode);
  }

  return new ParsedEnvSpecDecorator({ name, value, isBareFnCall });
}

function parsePlainCommentLeaf(text: string): ParsedEnvSpecComment {
  const match = text.match(/^#([ \t]*)([\s\S]*)$/);
  if (!match) throw new Error('Invalid comment token');
  return new ParsedEnvSpecComment({
    leadingSpace: match[1] ?? '',
    contents: match[2] ?? '',
  });
}

function parseStandaloneCommentText(text: string): ParsedEnvSpecComment {
  const parsed = parsePlainCommentLeaf(text);
  if (parsed.contents.startsWith('@')) {
    throw new Error('Malformed decorator comment');
  }
  return parsed;
}

function parsePostCommentLeaf(text: string): ParsedEnvSpecComment {
  const match = text.match(/^#([ \t]*)([\s\S]*)$/);
  if (!match) throw new Error('Invalid post-comment token');
  return new ParsedEnvSpecComment({
    leadingSpace: match[1] ?? '',
    contents: match[2] ?? '',
  });
}

function parseDecoratorCommentContainer(
  source: string,
  containerNode: CstNode,
): ParsedEnvSpecDecoratorComment {
  const hashLeaf = findPoundLeaf(source, containerNode);
  const decoratorCommentNode = findFirstNode(containerNode, 'DecoratorComment');
  if (!hashLeaf || !decoratorCommentNode) {
    throw new Error('Malformed decorator comment');
  }

  const leadingSpace = source.slice(hashLeaf.end, decoratorCommentNode.offset);
  const decoratorNodes = findNodes(decoratorCommentNode, 'Decorator').sort((a, b) => a.offset - b.offset);
  if (decoratorNodes.length === 0) {
    throw new Error('Malformed decorator comment');
  }

  for (let i = 1; i < decoratorNodes.length; i += 1) {
    const gap = source.slice(decoratorNodes[i - 1].end, decoratorNodes[i].offset);
    if (!/\s/.test(gap)) {
      throw new Error('Malformed decorator comment');
    }
  }

  const decorators = decoratorNodes.map((node) => parseDecoratorFromNode(source, node));
  const postCommentNode = findFirstNode(decoratorCommentNode, 'DecoratorPostComment')
    ?? findFirstNode(decoratorCommentNode, 'PostComment');
  const postStart = postCommentNode?.offset ?? decoratorCommentNode.end;

  for (let i = 0; i < decoratorNodes.length; i += 1) {
    const segmentStart = decoratorNodes[i].end;
    const segmentEnd = i < decoratorNodes.length - 1 ? decoratorNodes[i + 1].offset : postStart;
    const strayText = source.slice(segmentStart, segmentEnd).trim();
    if (strayText) {
      if (strayText.startsWith('=')) {
        throw new Error('Expected decorator value');
      }
      if (strayText.startsWith('(')) {
        throw new Error('Malformed decorator function call');
      }
      decorators[i].data.strayText = strayText;
    }
  }

  const postComment = postCommentNode
    ? parsePostCommentLeaf(source.slice(postCommentNode.offset, postCommentNode.end))
    : undefined;

  return new ParsedEnvSpecDecoratorComment({
    decorators,
    leadingSpace,
    postComment,
  });
}

function extractCommentText(
  source: string,
  node: CstNode,
  lineText?: string,
  lineStartOffset?: number,
): string {
  if (lineText === undefined || lineStartOffset === undefined) {
    return source.slice(node.offset, node.end);
  }

  const relativeStart = node.offset - lineStartOffset;
  const sameLineEnd = lineStartOffset + lineText.length;
  if (relativeStart < 0 || node.offset > sameLineEnd) {
    return source.slice(node.offset, node.end);
  }
  if (node.end > sameLineEnd) {
    return source.slice(node.offset, node.end);
  }
  return lineText.slice(relativeStart);
}

function parseDividerLeaf(text: string): ParsedEnvSpecDivider {
  const match = text.match(/^#([ \t]*)([-=~#]{3,}[\s\S]*)$/);
  if (!match) throw new Error('Invalid divider token');
  return new ParsedEnvSpecDivider({ leadingSpace: match[1], contents: match[2] });
}

function parseCommentStatement(
  source: string,
  statement: CstNode,
  lineText?: string,
  lineStartOffset?: number,
): ParsedCommentNode | undefined {
  if (findFirstLeaf(statement, 'ASSIGN_KEY')) {
    return undefined;
  }

  const decoratorLine = findFirstNode(statement, 'DecoratorCommentLine');
  if (decoratorLine) {
    return parseDecoratorCommentContainer(source, decoratorLine);
  }

  const trailingCommentNode = findFirstNode(statement, 'TrailingComment');
  if (trailingCommentNode) {
    const text = extractCommentText(source, trailingCommentNode, lineText, lineStartOffset);
    return parseStandaloneCommentText(text);
  }

  return undefined;
}

function parseStatementPostComment(
  source: string,
  statement: CstNode,
  lineText?: string,
  lineStartOffset?: number,
): ParsedCommentNode | undefined {
  const inlineDecorator = findFirstNode(statement, 'InlineDecoratorComment');
  if (inlineDecorator) {
    return parseDecoratorCommentContainer(source, inlineDecorator);
  }

  const postCommentNode = findFirstNode(statement, 'PostComment');
  if (postCommentNode) {
    const text = extractCommentText(source, postCommentNode, lineText, lineStartOffset);
    return parsePostCommentLeaf(text);
  }

  const trailingCommentNode = findFirstNode(statement, 'TrailingComment');
  if (trailingCommentNode) {
    const text = extractCommentText(source, trailingCommentNode, lineText, lineStartOffset);
    return parsePostCommentLeaf(text);
  }

  return undefined;
}

function lineStarts(source: string): Array<number> {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetToLineIndex(starts: Array<number>, offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (starts[mid] <= offset && (mid === starts.length - 1 || starts[mid + 1] > offset)) return mid;
    if (starts[mid] > offset) hi = mid - 1;
    else lo = mid + 1;
  }
  return starts.length - 1;
}

function flushPendingComments(
  pendingComments: Array<ParsedCommentNode>,
  output: Array<ParsedEnvSpecCommentBlock | ParsedEnvSpecDivider | ParsedEnvSpecConfigItem | ParsedEnvSpecBlankLine>,
) {
  if (pendingComments.length > 0) {
    const parsedComments = pendingComments.splice(0, pendingComments.length);
    output.push(new ParsedEnvSpecCommentBlock({
      comments: parsedComments,
      divider: null,
    }));
  }
}

export function parseWithMonogram(source: string): ParsedEnvSpecFile {
  const normalizedSource = source.includes('\r') ? source.replaceAll('\r\n', '\n') : source;
  const cst = monogramParser.parse(normalizedSource) as CstNode;
  const starts = lineStarts(normalizedSource);
  const lines = normalizedSource.split('\n');
  const statementByOffset = new Map<number, CstNode>();
  for (const child of cst.children) {
    if (!isNode(child) || child.rule !== 'Line') continue;
    const statement = child.children.find((lineChild) => isNode(lineChild) && lineChild.rule === 'Statement') as CstNode | undefined;
    if (statement) {
      statementByOffset.set(statement.offset, statement);
    }
  }

  const output: Array<
    ParsedEnvSpecCommentBlock | ParsedEnvSpecDivider | ParsedEnvSpecConfigItem | ParsedEnvSpecBlankLine
  > = [];
  const pendingComments: Array<ParsedCommentNode> = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const startOffset = starts[lineIndex] ?? 0;
    const statement = statementByOffset.get(startOffset);

    if (!statement) {
      if (line.trim() === '') {
        flushPendingComments(pendingComments, output);
        // no trailing blank line node at EOF without a terminal newline, unless the
        // line contains whitespace (`__ !.` in the peggy grammar produced a blank line)
        if (lineIndex < lines.length - 1 || line !== '') output.push(new ParsedEnvSpecBlankLine({}));
        continue;
      }
      throw new Error(`Unexpected content on line ${lineIndex + 1}`);
    }

    const endLine = offsetToLineIndex(starts, statement.end);
    lineIndex = endLine;

    const dividerLeaf = findFirstLeaf(statement, 'DIVIDER');
    if (dividerLeaf) {
      if (pendingComments.length > 0) {
        output.push(new ParsedEnvSpecCommentBlock({
          comments: pendingComments.splice(0, pendingComments.length),
          divider: parseDividerLeaf(leafText(normalizedSource, dividerLeaf)),
        }));
      } else {
        output.push(parseDividerLeaf(leafText(normalizedSource, dividerLeaf)));
      }
      continue;
    }

    const parsedComment = parseCommentStatement(normalizedSource, statement, line, startOffset);
    if (parsedComment) {
      pendingComments.push(parsedComment);
      continue;
    }

    const keyLeaf = findFirstLeaf(statement, 'ASSIGN_KEY');
    if (!keyLeaf) throw new Error(`Malformed statement at line ${lineIndex + 1}`);
    const valueNode = findFirstNode(statement, 'Value');
    const postComment = parseStatementPostComment(normalizedSource, statement, line, startOffset);
    let value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined;

    if (valueNode) {
      value = parseValueNode(normalizedSource, valueNode);
    }

    output.push(new ParsedEnvSpecConfigItem({
      key: leafText(normalizedSource, keyLeaf),
      value,
      preComments: pendingComments.splice(0, pendingComments.length),
      postComment,
    }));
  }

  flushPendingComments(pendingComments, output);
  return new ParsedEnvSpecFile(output);
}
