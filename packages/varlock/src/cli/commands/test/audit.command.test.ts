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
vi.mock('../../helpers/env-var-scanner', () => ({ scanCodeForEnvVars: scanCodeForEnvVarsMock }));
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
      configSchema: { API_KEY: {}, DATABASE_URL: {} },
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

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith({
      cwd: path.resolve('./backend'),
    });
  });

  test('scans from directory path when --path points to dir without trailing slash', async () => {
    fsStatMock.mockResolvedValue({ isDirectory: () => true });
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 2,
    });

    await commandFn({ values: { path: './config' } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith({
      cwd: path.resolve('./config'),
    });
  });

  test('scans from directory path when --path ends with slash', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['API_KEY', 'DATABASE_URL'],
      references: [],
      scannedFilesCount: 2,
    });

    await commandFn({ values: { path: './config/' } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledWith({
      cwd: path.resolve('./config/'),
    });
  });
});
