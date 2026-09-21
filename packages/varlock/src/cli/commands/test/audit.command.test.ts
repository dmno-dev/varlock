import path from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';

import { diffSchemaAndCodeKeys } from '../../helpers/audit-diff';
import { commandFn } from '../audit.command';

const {
  gracefulExitMock,
  loadVarlockEnvGraphMock,
  scanCodeForEnvVarsMock,
  fsStatMock,
} = vi.hoisted(() => ({
  gracefulExitMock: vi.fn(),
  loadVarlockEnvGraphMock: vi.fn(),
  scanCodeForEnvVarsMock: vi.fn(),
  fsStatMock: vi.fn(),
}));
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

vi.mock('exit-hook', () => ({ gracefulExit: gracefulExitMock }));
vi.mock('../../../lib/load-graph', () => ({ loadVarlockEnvGraph: loadVarlockEnvGraphMock }));
// only the scan itself is faked; exclusion normalization is pure logic the command
// should exercise for real
vi.mock('../../helpers/env-var-scanner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../helpers/env-var-scanner')>()),
  scanCodeForEnvVars: scanCodeForEnvVarsMock,
}));
vi.mock('node:fs/promises', () => ({ default: { stat: fsStatMock } }));
vi.mock('../../helpers/error-checks', () => ({
  checkForNoEnvFiles: vi.fn(),
  checkForSchemaErrors: vi.fn(),
}));

describe('diffSchemaAndCodeKeys', () => {
  test('finds missing and unused keys', () => {
    const diff = diffSchemaAndCodeKeys(
      ['A', 'B', 'C'],
      ['B', 'C', 'D', 'E'],
    );

    expect(diff.missingInSchema).toEqual(['D', 'E']);
    expect(diff.unusedInSchema).toEqual(['A']);
  });

  test('returns empty diff when in sync', () => {
    const diff = diffSchemaAndCodeKeys(
      ['API_KEY', 'DB_URL'],
      ['DB_URL', 'API_KEY'],
    );

    expect(diff.missingInSchema).toEqual([]);
    expect(diff.unusedInSchema).toEqual([]);
  });
});

describe('audit command', () => {
  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    gracefulExitMock.mockReset();
    loadVarlockEnvGraphMock.mockReset();
    scanCodeForEnvVarsMock.mockReset();
    fsStatMock.mockReset();
    fsStatMock.mockRejectedValue(new Error('missing'));

    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
        DATABASE_URL: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [], DATABASE_URL: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockReturnValue([]),
      rootDataSource: undefined,
      basePath: '/repo',
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('exits with code 1 when schema drift exists', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'MISSING_FROM_SCHEMA'],
      references: [
        {
          key: 'MISSING_FROM_SCHEMA',
          filePath: '/repo/src/index.ts',
          lineNumber: 10,
          columnNumber: 3,
          syntax: 'process.env.member',
        },
      ],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(1);
  });

  test('does not report execution-environment plumbing as missing in schema', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      // all code keys are either in the schema or pure plumbing (shell / node flags / npm_*)
      keys: ['API_KEY', 'DATABASE_URL', 'PATH', 'HOME', 'NODE_OPTIONS', 'npm_config_user_agent'],
      references: [],
      scannedFilesCount: 3,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(0);
    const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(errorOutput).not.toContain('Missing in schema');
  });

  test('still reports app-meaningful vars like NODE_ENV as missing in schema', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL', 'NODE_ENV'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(1);
    const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(errorOutput).toContain('NODE_ENV');
  });

  test('exits with code 0 when schema and code match', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 4,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });

  test('scans from schema path directory when --path is provided', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 2,
    });

    await commandFn({ values: { path: './backend/.env.schema' } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      {
        cwd: path.resolve('./backend'),
      },
      [],
    );
  });

  test('scans from directory path when --path points to dir without trailing slash', async () => {
    fsStatMock.mockResolvedValue({ isDirectory: () => true });
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 2,
    });

    await commandFn({ values: { path: './config' } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      {
        cwd: path.resolve('./config'),
      },
      [],
    );
  });

  test('scans from directory path when --path ends with slash', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 2,
    });

    await commandFn({ values: { path: './config/' } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      {
        cwd: path.resolve('./config/'),
      },
      [],
    );
  });

  test('treats # @auditIgnore as suppressed and # @auditIgnore=false as unsuppressed', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
        // getDec returns an ItemDecoratorInstance, not a bare boolean
        IGNORED_UNUSED: { getDec: vi.fn().mockReturnValue({ parsedDecorator: { simplifiedValue: true } }) }, // # @auditIgnore
        EXPLICIT_FALSE_UNUSED: { getDec: vi.fn().mockReturnValue({ parsedDecorator: { simplifiedValue: false } }) }, // # @auditIgnore=false
      },
      graphAdjacencyList: { API_KEY: [], IGNORED_UNUSED: [], EXPLICIT_FALSE_UNUSED: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockReturnValue([]),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(1);
    const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(errorOutput).toContain('EXPLICIT_FALSE_UNUSED');
    expect(errorOutput).not.toContain('IGNORED_UNUSED');
    expect(errorOutput).toContain('(Hint: If this is used by an external tool, add # @auditIgnore to the item)');
  });

  test('excludes internally referenced keys from unused-in-schema', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        APP_ENV: { getDec: vi.fn().mockReturnValue(undefined) },
        API_URL: { getDec: vi.fn().mockReturnValue(undefined) },
        DERIVED_URL: { getDec: vi.fn().mockReturnValue(undefined) },
        PLUGIN_TOKEN: { getDec: vi.fn().mockReturnValue(undefined) },
        ORPHAN_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      // DERIVED_URL depends on API_URL
      graphAdjacencyList: {
        APP_ENV: [],
        API_URL: [],
        DERIVED_URL: ['API_URL'],
        PLUGIN_TOKEN: [],
        ORPHAN_KEY: [],
      },
      sortedDataSources: [
        {
          rootDecorators: [
          // simple root decorator: @currentEnv=$APP_ENV
            { decValueResolver: { deps: ['APP_ENV'] } },
            // function-call root decorator: @initPlugin(token=$PLUGIN_TOKEN)
            { decValueResolver: { deps: ['PLUGIN_TOKEN'] } },
          ],
        },
      ],
      getRootDecFns: vi.fn().mockReturnValue([]),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['DERIVED_URL'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(gracefulExitMock).toHaveBeenCalledWith(1);
    const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    // APP_ENV is referenced by simple root decorator (@currentEnv), should not be reported
    expect(errorOutput).not.toContain('APP_ENV');
    // API_URL is depended on by DERIVED_URL, should not be reported
    expect(errorOutput).not.toContain('API_URL');
    // PLUGIN_TOKEN is referenced by function-call root decorator (@initPlugin), should not be reported
    expect(errorOutput).not.toContain('PLUGIN_TOKEN');
    // ORPHAN_KEY is not in code and not referenced internally, should be reported
    expect(errorOutput).toContain('ORPHAN_KEY');
  });

  test('flattens multiple # @auditIgnorePaths(...) calls and forwards merged excludes to scanner', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      // Name-aware like the real getRootDecFns: @auditExtraPatterns readers
      // must never see @auditIgnorePaths decorators (and vice versa).
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditIgnorePaths') return [];
        return [
          {
            resolve: vi.fn().mockResolvedValue({ arr: ['e2e', './scripts/'], obj: { unused: 'x' } }),
          },
          {
            resolve: vi.fn().mockResolvedValue({ arr: [['mocks']], obj: {} }),
          },
        ];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    // the message echoes what was written, while the scanner gets canonical entries:
    // names stay names, and `./scripts/` becomes an absolute path so it still means the
    // same directory when a positional target changes the scanner's cwd
    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️ Skipping ignored paths: e2e, ./scripts/, mocks');
    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      { cwd: '/repo' },
      ['e2e', 'mocks', path.resolve('/repo/scripts')],
    );
  });

  test('@auditIgnoreKeys drops matching keys from the missing-in-schema report', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditIgnoreKeys') return [];
        return [
          { resolve: vi.fn().mockResolvedValue({ arr: ['IN_A_STRING'], obj: {} }) },
          { resolve: vi.fn().mockResolvedValue({ arr: [['LEGACY_*']], obj: {} }) },
        ];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'IN_A_STRING', 'LEGACY_TOKEN', 'STILL_MISSING'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(errorOutput).toContain('Missing in schema (1)');
    expect(errorOutput).toContain('STILL_MISSING');
    expect(errorOutput).not.toContain('IN_A_STRING');
    expect(errorOutput).not.toContain('LEGACY_TOKEN');
    expect(gracefulExitMock).toHaveBeenCalledWith(1);
  });

  test('rejects a scan target that is itself excluded', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditIgnorePaths') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: ['./apps/docs'], obj: {} }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: { targets: ['./apps/docs'] } } as any))
      .rejects.toThrow(/Scan target "\.\/apps\/docs" is excluded from the audit scan/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('allows a scan target that merely contains an excluded directory', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditIgnorePaths') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: ['./apps/docs'], obj: {} }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'], references: [], scannedFilesCount: 1,
    });

    await commandFn({ values: { targets: ['./apps'] } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      { cwd: path.resolve('/repo/apps') },
      [path.resolve('/repo/apps/docs')],
    );
  });

  test('rejects a scan target that is never scanned anyway', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockReturnValue([]),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: { targets: ['./node_modules'] } } as any))
      .rejects.toThrow(/Scan target "\.\/node_modules" is never scanned/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('rejects an ignored path that is missing its ./', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditIgnorePaths') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: ['apps/docs'], obj: {} }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: {} } as any))
      .rejects.toThrow(/"apps\/docs" must start with "\.\/" to be treated as a path/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('rejects an --ignore value that is missing its ./', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockReturnValue([]),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: { ignore: ['apps/docs'] } } as any))
      .rejects.toThrow(/must start with "\.\/" to be treated as a path/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('forwards # @auditExtraPatterns(...) regexes to the scanner', async () => {
    const pattern = /config\.get\('([A-Z_]+)'\)/;
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        return [
          { resolve: vi.fn().mockResolvedValue({ arr: [pattern], obj: {} }) },
          { resolve: vi.fn().mockResolvedValue({ arr: [[/other\.get\("([A-Z_]+)"\)/]], obj: {} }) },
        ];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      { cwd: '/repo', extraPatterns: [{ pattern }, { pattern: /other\.get\("([A-Z_]+)"\)/ }] },
      [],
    );
  });

  test('scopes each call to its own fileTypes=[...] list', async () => {
    const tfPattern = /cfg\.get\("([A-Z_]+)"\)/;
    const anyPattern = /env\.([A-Z_]+)/;
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        return [
          { resolve: vi.fn().mockResolvedValue({ arr: [tfPattern], obj: { fileTypes: ['tf', 'yaml'] } }) },
          { resolve: vi.fn().mockResolvedValue({ arr: [anyPattern], obj: {} }) },
        ];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    // the fileTypes list rides along with the patterns from its own call, and only those
    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      {
        cwd: '/repo',
        extraPatterns: [
          { pattern: tfPattern, fileTypes: ['tf', 'yaml'] },
          { pattern: anyPattern },
        ],
      },
      [],
    );
  });

  test('rejects an unknown named option on # @auditExtraPatterns(...)', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: [/x([A-Z]+)/], obj: { extensions: ['tf'] } }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: {} } as any))
      .rejects.toThrow(/unknown option "extensions"/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('rejects fileTypes=[...] with no patterns in the same call', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: [], obj: { fileTypes: ['tf'] } }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: {} } as any))
      .rejects.toThrow(/no patterns to apply it to/);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });

  test('rejects non-regex # @auditExtraPatterns(...) entries', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {},
      graphAdjacencyList: {},
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        return [{ resolve: vi.fn().mockResolvedValue({ arr: ['not-a-regex'], obj: {} }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    await expect(commandFn({ values: {} } as any)).rejects.toThrow(/@auditExtraPatterns\(\) expects regex patterns/);
  });

  test('accepts quoted slash-delimited strings via the DSL string form', async () => {
    loadVarlockEnvGraphMock.mockResolvedValue({
      configSchema: {
        API_KEY: { getDec: vi.fn().mockReturnValue(undefined) },
      },
      graphAdjacencyList: { API_KEY: [] },
      sortedDataSources: [],
      getRootDecFns: vi.fn().mockImplementation((name: string) => {
        if (name !== 'auditExtraPatterns') return [];
        // What a quoted '/.../ ' decorator arg resolves to after parsing.
        return [{ resolve: vi.fn().mockResolvedValue({ arr: ['/config\\.get\\(\'([A-Z_]+)\'\\)/'], obj: {} }) }];
      }),
      rootDataSource: undefined,
      basePath: '/repo',
    });

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: {} } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith(
      { cwd: '/repo', extraPatterns: [{ pattern: /config\.get\('([A-Z_]+)'\)/ }] },
      [],
    );
  });
});
