import {
  Diagnostic,
  DiagnosticSeverity,
  Disposable,
  type ExtensionContext,
  languages,
  Position,
  Range,
  type TextDocument,
  Uri,
  workspace,
} from 'vscode';

import { LANG_ID } from './constants';
import { getCommentScope } from './completion-core';
import {
  createDecoratorDiagnostics,
  getDecoratorOccurrences,
  getTypeInfoFromPrecedingComments,
  isDynamicValue,
  stripInlineComment,
  unquote,
  type CoreDiagnostic,
  validateStaticValue,
} from './diagnostics-core';
import { createLineDocument } from './document-lines';

const ENV_ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function toRange(diagnostic: CoreDiagnostic) {
  return new Range(
    new Position(diagnostic.line, diagnostic.start),
    new Position(diagnostic.line, diagnostic.end),
  );
}

type DiagnosticsDocument = Pick<TextDocument, 'languageId' | 'lineCount' | 'lineAt'>;

export function validateDocument(document: DiagnosticsDocument) {
  if (document.languageId !== LANG_ID) return [];

  const diagnostics: Array<Diagnostic> = [];
  const lineDocument = createLineDocument(
    Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text),
  );
  let headerDecoratorBlock = [] as ReturnType<typeof getDecoratorOccurrences>;
  let decoratorBlock = [] as ReturnType<typeof getDecoratorOccurrences>;
  let hasSeenConfigItem = false;

  const flushHeaderDecoratorBlock = () => {
    if (!headerDecoratorBlock.length) return;
    diagnostics.push(
      ...createDecoratorDiagnostics(headerDecoratorBlock).map((diagnostic) => new Diagnostic(
        toRange(diagnostic),
        diagnostic.message,
        DiagnosticSeverity.Error,
      )),
    );
    headerDecoratorBlock = [];
  };

  const flushDecoratorBlock = () => {
    if (!decoratorBlock.length) return;
    diagnostics.push(
      ...createDecoratorDiagnostics(decoratorBlock).map((diagnostic) => new Diagnostic(
        toRange(diagnostic),
        diagnostic.message,
        DiagnosticSeverity.Error,
      )),
    );
    decoratorBlock = [];
  };

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const lineText = document.lineAt(lineNumber).text;
    const trimmed = lineText.trim();

    if (trimmed.startsWith('#')) {
      if (!hasSeenConfigItem && getCommentScope(lineDocument, lineNumber) === 'header') {
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

    const valueStart = lineText.indexOf(rawValue);
    diagnostics.push(new Diagnostic(
      new Range(
        new Position(lineNumber, Math.max(valueStart, 0)),
        new Position(lineNumber, Math.max(valueStart, 0) + rawValue.length),
      ),
      message,
      DiagnosticSeverity.Error,
    ));
  }

  flushHeaderDecoratorBlock();
  flushDecoratorBlock();
  return diagnostics;
}

export function addDiagnosticsProvider(context: ExtensionContext) {
  const collection = languages.createDiagnosticCollection(LANG_ID);

  const refresh = (document: TextDocument) => {
    if (document.languageId !== LANG_ID) return;
    collection.set(document.uri, validateDocument(document));
  };

  const remove = (uri: Uri) => {
    collection.delete(uri);
  };

  context.subscriptions.push(
    collection,
    workspace.onDidOpenTextDocument(refresh),
    workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    workspace.onDidCloseTextDocument((document) => remove(document.uri)),
    new Disposable(() => {
      workspace.textDocuments
        .filter((document) => document.languageId === LANG_ID)
        .forEach(refresh);
    }),
  );

  workspace.textDocuments
    .filter((document) => document.languageId === LANG_ID)
    .forEach(refresh);
}
