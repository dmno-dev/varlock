import {
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  type ExtensionContext,
  languages,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  type TextDocument,
} from 'vscode';

import {
  filterAvailableDecorators,
  getDecoratorCommentPrefix,
  getEnumValuesFromPrecedingComments,
  getExistingDecoratorNames,
  getTypeOptionDataType,
  isInHeader,
} from './completion-core';
import { LANG_ID } from './constants';
import {
  DATA_TYPES,
  ITEM_DECORATORS,
  type DecoratorInfo,
  type DataTypeInfo,
  DECORATORS_BY_NAME,
  type ResolverInfo,
  RESOLVERS,
  ROOT_DECORATORS,
} from './intellisense-catalog';

const ENV_KEY_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

type MatchContext = {
  replaceRange: Range;
};

type EnumValueContext = MatchContext & {
  enumValues: Array<string>;
};

function buildMarkdown(summary: string, documentation: string, extraLine?: string) {
  const md = new MarkdownString();
  md.appendMarkdown(`${summary}\n\n${documentation}`);
  if (extraLine) md.appendMarkdown(`\n\n${extraLine}`);
  md.isTrusted = false;
  return md;
}

function withDeprecatedState(item: CompletionItem, deprecated?: string) {
  if (deprecated) {
    item.tags = [CompletionItemTag.Deprecated];
    item.sortText = `z-${item.label}`;
  }
}

function createDecoratorItem(info: DecoratorInfo, context: MatchContext) {
  const item = new CompletionItem(`@${info.name}`, CompletionItemKind.Property);
  item.range = context.replaceRange;
  item.insertText = new SnippetString(info.insertText);
  item.detail = info.scope === 'root' ? 'Root decorator' : 'Item decorator';
  item.documentation = buildMarkdown(
    info.summary,
    info.documentation,
    info.deprecated ? `Deprecated: ${info.deprecated}` : undefined,
  );
  withDeprecatedState(item, info.deprecated);
  return item;
}

function createDataTypeItem(info: DataTypeInfo, context: MatchContext) {
  const item = new CompletionItem(info.name, CompletionItemKind.Class);
  item.range = context.replaceRange;
  item.insertText = new SnippetString(info.insertText ?? info.name);
  item.detail = '@type data type';
  item.documentation = buildMarkdown(info.summary, info.documentation);
  return item;
}

function createDataTypeOptionItem(
  option: NonNullable<DataTypeInfo['optionSnippets']>[number],
  context: MatchContext,
) {
  const item = new CompletionItem(option.name, CompletionItemKind.Field);
  item.range = context.replaceRange;
  item.insertText = new SnippetString(option.insertText);
  item.detail = '@type option';
  item.documentation = new MarkdownString(option.documentation);
  return item;
}

function createResolverItem(info: ResolverInfo, context: MatchContext) {
  const item = new CompletionItem(`${info.name}()`, CompletionItemKind.Function);
  item.range = context.replaceRange;
  item.insertText = new SnippetString(info.insertText);
  item.detail = 'Resolver function';
  item.documentation = buildMarkdown(info.summary, info.documentation);
  return item;
}

function createReferenceItems(document: TextDocument, context: MatchContext) {
  const keys = new Set<string>(['VARLOCK_ENV']);
  for (let i = 0; i < document.lineCount; i += 1) {
    const match = document.lineAt(i).text.match(ENV_KEY_PATTERN);
    if (match) keys.add(match[1]);
  }

  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const item = new CompletionItem(key, CompletionItemKind.Variable);
      item.range = context.replaceRange;
      item.insertText = key;
      item.detail = 'Config item reference';
      item.documentation = new MarkdownString(`Reference \`${key}\` with \`$${key}\`.`);
      return item;
    });
}

function matchDecoratorName(commentPrefix: string, position: Position) {
  const match = commentPrefix.match(/(^|\s)(@[\w-]*)$/);
  if (!match) return undefined;

  const token = match[2];
  return {
    replaceRange: new Range(position.line, position.character - token.length, position.line, position.character),
  };
}

function matchTypeValue(commentPrefix: string, position: Position) {
  const match = commentPrefix.match(/(^|\s)@type=([\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[2];
  return {
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
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
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
  };
}

function matchReference(linePrefix: string, position: Position) {
  const match = linePrefix.match(/\$([A-Za-z0-9_]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
  };
}

function matchResolverValue(linePrefix: string, position: Position) {
  const match = linePrefix.match(/(?:=\s*|[(,]\s*)([A-Za-z][\w-]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
  };
}

function matchDecoratorValue(commentPrefix: string, position: Position) {
  const match = commentPrefix.match(/(^|\s)@([\w-]+)=([A-Za-z][\w-]*)$/);
  if (!match) return undefined;

  const decorator = DECORATORS_BY_NAME[match[2]];
  const typedValue = match[3];

  return {
    decorator,
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
  };
}

function createKeywordItems(values: Array<string>, context: MatchContext) {
  return values.map((value) => {
    const item = new CompletionItem(value, CompletionItemKind.Value);
    item.range = context.replaceRange;
    item.insertText = value;
    return item;
  });
}

function createDecoratorValueItems(document: TextDocument, context: MatchContext & { decorator?: DecoratorInfo }) {
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

function matchItemValue(linePrefix: string, position: Position) {
  const match = linePrefix.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z0-9._-]*)$/);
  if (!match) return undefined;

  const typedValue = match[1];
  return {
    replaceRange: new Range(position.line, position.character - typedValue.length, position.line, position.character),
  };
}

function getEnumValueContext(document: TextDocument, position: Position, linePrefix: string) {
  const itemContext = matchItemValue(linePrefix, position);
  if (!itemContext) return undefined;

  const enumValues = getEnumValuesFromPrecedingComments(document, position.line);
  if (!enumValues) return undefined;

  return {
    ...itemContext,
    enumValues,
  } satisfies EnumValueContext;
}

function createEnumValueItems(context: EnumValueContext) {
  return context.enumValues.map((value) => {
    const item = new CompletionItem(value, CompletionItemKind.EnumMember);
    item.range = context.replaceRange;
    item.insertText = value;
    item.detail = '@type=enum value';
    item.documentation = new MarkdownString(`Allowed enum value \`${value}\`.`);
    return item;
  });
}

export function addCompletionProvider(context: ExtensionContext) {
  const disposable = languages.registerCompletionItemProvider(
    LANG_ID,
    {
      provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const commentStart = linePrefix.indexOf('#');
        const commentPrefix = commentStart >= 0 ? getDecoratorCommentPrefix(linePrefix) : undefined;

        const referenceContext = matchReference(linePrefix, position);
        if (referenceContext) {
          return createReferenceItems(document, referenceContext);
        }

        const enumValueContext = getEnumValueContext(document, position, linePrefix);
        if (enumValueContext) {
          return createEnumValueItems(enumValueContext);
        }

        if (commentPrefix) {
          const existingDecoratorNames = getExistingDecoratorNames(document, position.line, commentPrefix);

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
            const decorators = isInHeader(document, position.line) ? ROOT_DECORATORS : ITEM_DECORATORS;
            return filterAvailableDecorators(decorators, existingDecoratorNames)
              .map((info) => createDecoratorItem(info, decoratorContext));
          }
        }

        const resolverContext = matchResolverValue(linePrefix, position);
        if (resolverContext) {
          return RESOLVERS.map((info) => createResolverItem(info, resolverContext));
        }

        return undefined;
      },
    },
    '@',
    '$',
    '=',
    '(',
    ',',
  );
  context.subscriptions.push(disposable);
}
