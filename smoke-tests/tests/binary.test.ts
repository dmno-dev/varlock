import { describe, test, expect } from 'vitest';
import {
  runBinary, binaryRun, BINARY_PATH,
} from '../helpers/run-varlock-binary.js';

describe('Compiled binary tests', () => {
  test('--version prints version', () => {
    const result = runBinary(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/\d+\.\d+\.\d+/);
  });

  test('--help shows usage', () => {
    const result = runBinary(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('varlock');
  });

  test('run injects env vars into child process', () => {
    const result = binaryRun(
      ['node', '-e', 'console.log("PUBLIC_VAR=" + process.env.PUBLIC_VAR)'],
      { cwd: 'smoke-test-basic' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('PUBLIC_VAR=public-value');
  });

  test('run propagates exit code from child', () => {
    const result = binaryRun(
      ['node', '-e', 'process.exit(42)'],
      { cwd: 'smoke-test-basic' },
    );

    expect(result.exitCode).toBe(42);
  });

  describe('nested varlock run (issue #312)', () => {
    test('inner binary can run and inject env vars', () => {
      // Outer varlock run spawns inner varlock run, which spawns node
      const result = binaryRun(
        [
          BINARY_PATH,
          'run',
          '--',
          'node',
          '-e',
          'console.log("PUBLIC_VAR=" + process.env.PUBLIC_VAR)',
        ],
        { cwd: 'smoke-test-basic' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('PUBLIC_VAR=public-value');
    });

    test('inner binary sees correct env values', () => {
      // Use --no-redact-stdout on the outer run so the inner output is not redacted
      const result = runBinary(
        [
          'run',
          '--no-redact-stdout',
          '--',
          BINARY_PATH,
          'run',
          '--no-redact-stdout',
          '--',
          'node',
          '-e',
          `
            const vars = {
              NODE_ENV: process.env.NODE_ENV,
              PUBLIC_VAR: process.env.PUBLIC_VAR,
              SECRET_TOKEN: process.env.SECRET_TOKEN,
            };
            console.log(JSON.stringify(vars));
          `,
        ],
        { cwd: 'smoke-test-basic' },
      );

      expect(result.exitCode).toBe(0);
      const vars = JSON.parse(result.stdout.trim().split('\n').pop()!);
      expect(vars.NODE_ENV).toBe('test');
      expect(vars.PUBLIC_VAR).toBe('public-value');
      expect(vars.SECRET_TOKEN).toBe('super-secret-token-12345');
    });

    test('inner binary propagates exit code', () => {
      const result = binaryRun(
        [
          BINARY_PATH,
          'run',
          '--',
          'node',
          '-e',
          'process.exit(7)',
        ],
        { cwd: 'smoke-test-basic' },
      );

      expect(result.exitCode).toBe(7);
    });

    test('inner binary --version works (argv not corrupted)', () => {
      // This specifically guards against the original PKG_EXECPATH issue
      // where the inner binary misinterpreted its own argv
      const result = binaryRun(
        [BINARY_PATH, '--version'],
        { cwd: 'smoke-test-basic' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/\d+\.\d+\.\d+/);
    });
  });
});
