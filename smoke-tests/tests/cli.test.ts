import {
  describe, test, expect, beforeEach,
} from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  varlockLoad, varlockRun, varlockPrintenv, runVarlock,
} from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

describe('CLI Commands', () => {
  test('varlock --help should work', () => {
    const result = runVarlock(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('varlock');
  });

  test('varlock load should succeed', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(0);
  });

  describe('package.json loadPath config', () => {
    test('varlock load respects loadPath from package.json', () => {
      const result = varlockLoad({ cwd: 'smoke-test-pkg-json-config' });
      expect(result.exitCode).toBe(0);
    });

    test('varlock printenv resolves variable using loadPath from package.json', () => {
      const result = varlockPrintenv('PKG_JSON_VAR', { cwd: 'smoke-test-pkg-json-config' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-from-pkg-json-config');
    });
  });

  test('varlock load --format json should output valid JSON', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic', format: 'json' });
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test('varlock load --format shell should output export statements', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic', format: 'shell' });
    expect(result.exitCode).toBe(0);
    // Every non-empty line should start with "export "
    const lines = result.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^export [A-Z_]+=.*/);
    }
  });

  describe('printenv command', () => {
    test('varlock printenv prints a public variable value', () => {
      const result = varlockPrintenv('PUBLIC_VAR', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('public-value');
    });

    test('varlock printenv prints a sensitive variable value', () => {
      const result = varlockPrintenv('SECRET_TOKEN', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('super-secret-token-12345');
    });

    test('varlock printenv with --path flag prints variable value', () => {
      const result = varlockPrintenv('PUBLIC_VAR', {
        cwd: 'smoke-test-basic',
        path: '.env.schema',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('public-value');
    });

    test('varlock printenv with unknown variable returns error', () => {
      const result = varlockPrintenv('DOES_NOT_EXIST', { cwd: 'smoke-test-basic' });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('DOES_NOT_EXIST');
    });

    test('varlock printenv with no variable name returns error', () => {
      const result = runVarlock(['printenv'], { cwd: 'smoke-test-basic', captureOutput: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('Missing required argument');
    });
  });

  describe('type generation', () => {
    const typeFilePath = join(SMOKE_TESTS_DIR, 'smoke-test-basic', 'env.d.ts');
    const typeFilePathAutoFalse = join(SMOKE_TESTS_DIR, 'smoke-test-typegen-auto', 'env.d.ts');

    beforeEach(() => {
      // Clean up generated type files before each test
      if (existsSync(typeFilePath)) rmSync(typeFilePath);
      if (existsSync(typeFilePathAutoFalse)) rmSync(typeFilePathAutoFalse);
    });

    test('varlock load generates type file when @generateTypes is set', () => {
      expect(existsSync(typeFilePath)).toBe(false);
      const result = varlockLoad({ cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePath)).toBe(true);
    });

    test('varlock run generates type file when @generateTypes is set', () => {
      expect(existsSync(typeFilePath)).toBe(false);
      const result = varlockRun(['node', '-e', 'process.exit(0)'], { cwd: 'smoke-test-basic' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePath)).toBe(true);
    });

    test('varlock load skips type generation when auto=false', () => {
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
      const result = varlockLoad({ cwd: 'smoke-test-typegen-auto' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
    });

    test('varlock run skips type generation when auto=false', () => {
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
      const result = varlockRun(['node', '-e', 'process.exit(0)'], { cwd: 'smoke-test-typegen-auto' });
      expect(result.exitCode).toBe(0);
      expect(existsSync(typeFilePathAutoFalse)).toBe(false);
    });
  });
});
