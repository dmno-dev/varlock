import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  InsertTextFormat,
  MarkupKind,
  Position,
  Range,
  TextDocumentSyncKind,
} from 'vscode-languageserver';

import {
  filterAvailableDecorators,
  getDecoratorCommentPrefix,
  getEnumValuesFromPrecedingComments,
  getExistingDecoratorNames,
  getTypeOptionDataType,
  isInHeader,
} from './completion-core';
import {
  createDecoratorDiagnostics,
  getDecoratorOccurrences,
  getTypeInfoFromPrecedingComments,
  isDynamicValue,
  stripInlineComment,
  unquote,
  validateStaticValue,
} from './diagnostics-core';
import { createLineDocument, type LineDocument } from './document-lines';
import {
  DATA_TYPES,
  DECORATORS_BY_NAME,
  type DataTypeInfo,
  type DecoratorInfo,
  ITEM_DECORATORS,
  RESOLVERS,
  ROOT_DECORATORS,
  type ResolverInfo,
} from './intellisense-catalog';
import { createSemanticTokens, SEMANTIC_TOKENS_LEGEND } from './semantic-tokens';

const LANG_ID = 'env-spec';
const ENV_KEY_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const ENV_ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function log(message: string) {
  process.stderr.write(`[env-spec-lsp] ${message}\n`);
}

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});

process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});

log(`starting; cwd=${process.cwd()}; argv=${process.argv.join(' ')}`);

type MatchContext = {
  replaceRange: Range;
};

type EnumValueContext = MatchContext & {
  enumValues: Array<string>;
};

type TextDocument = {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
};

const connection = createConnection(process.stdin, process.stdout);
const documents = new Map<string, TextDocument>();

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    completionProvider: {
      triggerCharacters: ['@', '$', '=', '(', ','],
      resolveProvider: false,
    },
    hoverProvider: true,
    semanticTokensProvider: {
      legend: SEMANTIC_TOKENS_LEGEND,
      full: true,
    },
  },
}));

connection.onInitialized(() => {
  log('initialized');
});

connection.onDidOpenTextDocument((params) => {
  const document = createTextDocument(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text,
  );
  documents.set(document.uri, document);
  log(`opened ${document.uri} languageId=${document.languageId}`);
  validateTextDocument(document);
});

connection.onDidChangeTextDocument((params) => {
  const existing = documents.get(params.textDocument.uri);
  const text = params.contentChanges[0]?.text;
  if (text === undefined) return;

  const document = createTextDocument(
    params.textDocument.uri,
    existing?.languageId ?? LANG_ID,
    params.textDocument.version ?? existing?.version ?? 0,
    text,
  );
  documents.set(document.uri, document);
  validateTextDocument(document);
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onCompletion((params): CompletionItem[] | undefined => {
  const document = getDocument(params.textDocument.uri);
  if (!document) return undefined;

  const position = params.position;
  const line = getLine(document, position.line);
  const linePrefix = line.slice(0, position.character);
  const commentStart = linePrefix.indexOf('#');
  const commentPrefix = commentStart >= 0 ? getDecoratorCommentPrefix(linePrefix) : undefined;
  const lineDocument = createLineDocument(getLines(document));

  const referenceContext = matchReference(linePrefix, position);
  if (referenceContext) {
    return createReferenceItems(document, referenceContext);
  }

  const enumValueContext = getEnumValueContext(lineDocument, position, linePrefix);
  if (enumValueContext) {
    return createEnumValueItems(enumValueContext);
  }

  if (commentPrefix) {
    const existingDecoratorNames = getExistingDecoratorNames(lineDocument, position.line, commentPrefix);

    const typeOptionContext = matchTypeOption(commentPrefix, position);
    if (typeOptionContext) {
      return typeOptionContext.dataType.optionSnippets!.map(
        (option) => createDataTypeOptionItem(option, typeOptionContext),
      );
    }

    const typeContext = matchTypeValue(commentPrefix, position);
    if (typeContext) {
      return DATA_TYPES.map((info) => createDataTypeItem(info, typeContext));
    }

    const decoratorValueContext = matchDecoratorValue(commentPrefix, position);
    if (decoratorValueContext) {
      return createDecoratorValueItems(document, decoratorValueContext);
    }

    const decoratorContext = matchDecoratorName(commentPrefix, position);
    if (decoratorContext) {
      const decorators = isInHeader(lineDocument, position.line) ? ROOT_DECORATORS : ITEM_DECORATORS;
      return filterAvailableDecorators(decorators, existingDecoratorNames)
        .map((info) => createDecoratorItem(info, decoratorContext));
    }
  }

  const resolverContext = matchResolverValue(linePrefix, position);
  if (resolverContext) {
    return RESOLVERS.map((info) => createResolverItem(info, resolverContext));
  }

  return undefined;
});

connection.onHover((params): Hover | undefined => {
  const document = getDocument(params.textDocument.uri);
  if (!document) return undefined;

  const line = getLine(document, params.position.line);
  if (!line.trim().startsWith('#')) return undefined;

  const word = getDecoratorWordAtPosition(line, params.position.character);
  if (!word?.startsWith('@')) return undefined;

  const decorator = DECORATORS_BY_NAME[word.slice(1)];
  if (!decorator) return undefined;

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `${decorator.summary}\n\n${decorator.documentation}`,
    },
  };
});

connection.languages.semanticTokens.on((params) => {
  const document = getDocument(params.textDocument.uri);
  return createSemanticTokens(document ? getLines(document) : []);
});

connection.listen();

function createTextDocument(uri: string, languageId: string, version: number, text: string): TextDocument {
  return {
    uri,
    languageId,
    version,
    getText() {
      return text;
    },
  };
}

function getLines(document: TextDocument) {
  return document.getText().split(/\r?\n/);
}

function getDocument(uri: string) {
  return documents.get(uri);
}

function getLine(document: TextDocument, line: number) {
  return getLines(document)[line] ?? '';
}

function buildMarkdown(summary: string, documentation: string, extraLine?: string) {
  return {
    kind: MarkupKind.Markdown,
    value: `${summary}\n\n${documentation}${extraLine ? `\n\n${extraLine}` : ''}`,
  };
}

function withDeprecatedState(item: CompletionItem, deprecated?: string) {
  if (deprecated) {
    (item as CompletionItem & { tags?: number[] }).tags = [1];
    item.sortText = `z-${item.label}`;
  }
}

function createDecoratorItem(info: DecoratorInfo, context: MatchContext): CompletionItem {
  const item: CompletionItem = {
    label: `@${info.name}`,
    kind: CompletionItemKind.Property,
    textEdit: {
      range: context.replaceRange,
      newText: info.insertText,
    },
    insertTextFormat: InsertTextFormat.Snippet,
    detail: info.scope === 'root' ? 'Root decorator' : 'Item decorator',
    documentation: buildMarkdown(
      info.summary,
      info.documentation,
      info.deprecated ? `Deprecated: ${info.deprecated}` : undefined,
    ),
  };
  withDeprecatedState(item, info.deprecated);
  return item;
}

function createDataTypeItem(info: DataTypeInfo, context: MatchContext): CompletionItem {
  return {
    label: info.name,
    kind: CompletionItemKind.Class,
    textEdit: {
      range: context.replaceRange,
      newText: info.insertText ?? info.name,
    },
    insertTextFormat: InsertTextFormat.Snippet,
    detail: '@type data type',
    documentation: buildMarkdown(info.summary, info.documentation),
  };
}

function createDataTypeOptionItem(
  option: NonNullable<DataTypeInfo['optionSnippets']>[number],
  context: MatchContext,
): CompletionItem {
  return {
    label: option.name,
    kind: CompletionItemKind.Field,
    textEdit: {
      range: context.replaceRange,
      newText: option.insertText,
    },
    insertTextFormat: InsertTextFormat.Snippet,
    detail: '@type option',
    documentation: {
      kind: MarkupKind.Markdown,
      value: option.documentation,
    },
  };
}

function createResolverItem(info: ResolverInfo, context: MatchContext): CompletionItem {
  return {
    label: `${info.name}()`,
    kind: CompletionItemKind.Function,
    textEdit: {
      range: context.replaceRange,
      newText: info.insertText,
    },
    insertTextFormat: InsertTextFormat.Snippet,
    detail: 'Resolver function',
    documentation: buildMarkdown(info.summary, info.documentation),
  };
}

function createReferenceItems(document: TextDocument, context: MatchContext): CompletionItem[] {
  const keys = new Set<string>(['VARLOCK_ENV']);
  for (const line of getLines(document)) {
    const match = line.match(ENV_KEY_PATTERN);
    if (match) keys.add(match[1]);
  }

  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      label: key,
      kind: CompletionItemKind.Variable,
      textEdit: {
        range: context.replaceRange,
        newText: key,
      },
      detail: 'Config item reference',
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Reference \`${key}\` with \`$${key}\`.`,
      },
    }));
}

function matchDecoratorName(commentPrefix: string, position: Position): MatchContext | undefined {
  const match = commentPrefix.match(/(^|\s)(@[\w-]*)$/);
  if (!match) return undefined;

  const token = match[2];
  return {
    replaceRange: rangeForTypedValue(position, token.length),
  };
}

function matchTypeValue(commentPrefix: string, position: Position): MatchContext | undefined {
  const match = commentPrefix.match(/(^|\s)@type=([\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[2];
  return {
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function matchTypeOption(commentPrefix: string, position: Position) {
  const dataType = getTypeOptionDataType(DATA_TYPES, commentPrefix);
  if (!dataType?.optionSnippets?.length) return undefined;

  const match = commentPrefix.match(/(^|\s)@type=([A-Za-z][\w-]*)\((?:[^#)]*?,\s*)?([\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[3];
  return {
    dataType,
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function matchReference(linePrefix: string, position: Position): MatchContext | undefined {
  const match = linePrefix.match(/\$([A-Za-z0-9_]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function matchResolverValue(linePrefix: string, position: Position): MatchContext | undefined {
  const match = linePrefix.match(/(?:=\s*|[(,]\s*)([A-Za-z][\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function matchDecoratorValue(commentPrefix: string, position: Position) {
  const match = commentPrefix.match(/(^|\s)@([\w-]+)=([A-Za-z][\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[3];
  return {
    decorator: DECORATORS_BY_NAME[match[2]],
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function createKeywordItems(values: Array<string>, context: MatchContext): CompletionItem[] {
  return values.map((value) => ({
    label: value,
    kind: CompletionItemKind.Value,
    textEdit: {
      range: context.replaceRange,
      newText: value,
    },
  }));
}

function createDecoratorValueItems(
  document: TextDocument,
  context: MatchContext & { decorator?: DecoratorInfo },
): CompletionItem[] | undefined {
  switch (context.decorator?.name) {
    case 'currentEnv':
      return createReferenceItems(document, context);
    case 'defaultRequired':
      return createKeywordItems(['infer', 'true', 'false'], context);
    case 'defaultSensitive':
      return [
        ...createKeywordItems(['true', 'false'], context),
        ...RESOLVERS
          .filter((resolver) => resolver.name === 'inferFromPrefix')
          .map((info) => createResolverItem(info, context)),
      ];
    case 'required':
    case 'optional':
    case 'sensitive':
    case 'public':
    case 'disable':
      return [
        ...createKeywordItems(['true', 'false'], context),
        ...RESOLVERS
          .filter((resolver) => ['forEnv', 'eq', 'if', 'not', 'isEmpty'].includes(resolver.name))
          .map((info) => createResolverItem(info, context)),
      ];
    default:
      return undefined;
  }
}

function matchItemValue(linePrefix: string, position: Position): MatchContext | undefined {
  const match = linePrefix.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z0-9._-]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: rangeForTypedValue(position, typedValue.length),
  };
}

function getEnumValueContext(
  document: LineDocument,
  position: Position,
  linePrefix: string,
): EnumValueContext | undefined {
  const itemContext = matchItemValue(linePrefix, position);
  if (!itemContext) return undefined;

  const enumValues = getEnumValuesFromPrecedingComments(document, position.line);
  if (!enumValues) return undefined;

  return {
    ...itemContext,
    enumValues,
  };
}

function createEnumValueItems(context: EnumValueContext): CompletionItem[] {
  return context.enumValues.map((value) => ({
    label: value,
    kind: CompletionItemKind.EnumMember,
    textEdit: {
      range: context.replaceRange,
      newText: value,
    },
    detail: '@type=enum value',
    documentation: {
      kind: MarkupKind.Markdown,
      value: `Allowed enum value \`${value}\`.`,
    },
  }));
}

function rangeForTypedValue(position: Position, typedLength: number): Range {
  return {
    start: { line: position.line, character: position.character - typedLength },
    end: position,
  };
}

function validateTextDocument(document: TextDocument) {
  const diagnostics: Diagnostic[] = [];
  const lineDocument = createLineDocument(getLines(document));
  let headerDecoratorBlock: ReturnType<typeof getDecoratorOccurrences> = [];
  let decoratorBlock: ReturnType<typeof getDecoratorOccurrences> = [];
  let hasSeenConfigItem = false;

  const flushHeaderDecoratorBlock = () => {
    if (!headerDecoratorBlock.length) return;
    diagnostics.push(...createDecoratorDiagnostics(headerDecoratorBlock).map(toDiagnostic));
    headerDecoratorBlock = [];
  };

  const flushDecoratorBlock = () => {
    if (!decoratorBlock.length) return;
    diagnostics.push(...createDecoratorDiagnostics(decoratorBlock).map(toDiagnostic));
    decoratorBlock = [];
  };

  for (let lineNumber = 0; lineNumber < lineDocument.lineCount; lineNumber += 1) {
    const lineText = lineDocument.lineAt(lineNumber).text;
    const trimmed = lineText.trim();

    if (trimmed.startsWith('#')) {
      if (!hasSeenConfigItem && isInHeader(lineDocument, lineNumber)) {
        headerDecoratorBlock.push(...getDecoratorOccurrences(lineText, lineNumber));
      } else {
        decoratorBlock.push(...getDecoratorOccurrences(lineText, lineNumber));
      }
    } else if (trimmed === '' && !hasSeenConfigItem) {
      continue;
    } else {
      flushHeaderDecoratorBlock();
      flushDecoratorBlock();
    }

    const match = lineText.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) continue;
    hasSeenConfigItem = true;

    const rawValue = stripInlineComment(match[2]);
    if (!rawValue) continue;
    if (isDynamicValue(rawValue)) continue;

    const typeInfo = getTypeInfoFromPrecedingComments(lineDocument, lineNumber);
    if (!typeInfo) continue;

    const message = validateStaticValue(typeInfo, unquote(rawValue));
    if (!message) continue;

    const valueStart = Math.max(lineText.indexOf(rawValue), 0);
    diagnostics.push({
      range: {
        start: { line: lineNumber, character: valueStart },
        end: { line: lineNumber, character: valueStart + rawValue.length },
      },
      message,
      severity: DiagnosticSeverity.Error,
      source: LANG_ID,
    });
  }

  flushHeaderDecoratorBlock();
  flushDecoratorBlock();
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function toDiagnostic(diagnostic: { line: number; start: number; end: number; message: string }): Diagnostic {
  return {
    range: {
      start: { line: diagnostic.line, character: diagnostic.start },
      end: { line: diagnostic.line, character: diagnostic.end },
    },
    message: diagnostic.message,
    severity: DiagnosticSeverity.Error,
    source: LANG_ID,
  };
}

function getDecoratorWordAtPosition(line: string, character: number) {
  const pattern = /@?[a-z0-9]+/gi;
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) return match[0];
  }
  return undefined;
}
