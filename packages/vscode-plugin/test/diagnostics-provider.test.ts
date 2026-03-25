import {
  beforeAll, describe, expect, it, vi,
} from 'vitest';

vi.mock('vscode', () => ({
  Diagnostic: class {
    range: unknown;
    message: string;
    severity: unknown;

    constructor(range: unknown, message: string, severity: unknown) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: { Error: 0 },
  Disposable: class {},
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
  languages: { createDiagnosticCollection: vi.fn() },
  workspace: {
    onDidOpenTextDocument: vi.fn(),
    onDidChangeTextDocument: vi.fn(),
    onDidCloseTextDocument: vi.fn(),
    textDocuments: [],
  },
}));

let validateDocument: typeof import('../src/diagnostics-provider').validateDocument;

beforeAll(async () => {
  ({ validateDocument } = await import('../src/diagnostics-provider'));
});

function createTestDocument(lines: Array<string>) {
  return {
    languageId: 'env-spec',
    lineCount: lines.length,
    lineAt(line: number) {
      return { text: lines[line] };
    },
  };
}

describe('diagnostics-provider', () => {
  it('keeps the header scope across blank lines before the first config item', () => {
    const diagnostics = validateDocument(createTestDocument([
      '# @defaultRequired=true',
      '',
      '# @defaultRequired=false',
      '',
      '# @required',
      '',
      'ITEM=',
    ]));

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      '@defaultRequired can only be used once in the same decorator block.',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      '@required can only be used once in the same decorator block.',
    );
  });

  it('treats the last comment block before the first item as item-attached', () => {
    const diagnostics = validateDocument(createTestDocument([
      '# @defaultRequired=true',
      '',
      '# @required',
      '# @required',
      'ITEM=',
    ]));

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      '@required can only be used once in the same decorator block.',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      '@defaultRequired can only be used once in the same decorator block.',
    );
  });
});
