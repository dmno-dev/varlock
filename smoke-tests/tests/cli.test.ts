import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { varlockLoad, varlockTypegen, runVarlock } from '../helpers/run-varlock.js';

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

  test('varlock load --format json should output valid JSON', () => {
    const result = varlockLoad({ cwd: 'smoke-test-basic', format: 'json' });
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test('varlock typegen should regenerate types without validation output', () => {
    const result = varlockTypegen({ cwd: 'smoke-test-basic' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    const envDTsPath = join(SMOKE_TESTS_DIR, 'smoke-test-basic', 'env.d.ts');
    expect(existsSync(envDTsPath)).toBe(true);
    const contents = readFileSync(envDTsPath, 'utf-8');
    expect(contents).toContain('NODE_ENV');
    expect(contents).toContain('PUBLIC_VAR');
    expect(contents).toContain('SECRET_TOKEN');
  });
});
