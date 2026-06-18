import { describe, test, expect } from 'vitest';
import { varlockRun, runVarlock } from '../helpers/run-varlock.js';

describe('Log Redaction', () => {
  test('should load env vars correctly', () => {
    const result = varlockRun(['node', 'test-script.js'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.output).toContain('NODE_ENV: test');
    expect(result.output).toContain('PUBLIC_VAR: public-value');
    expect(result.output).toContain('All env vars loaded correctly');
  });

  test('should redact sensitive values in logs', () => {
    const result = varlockRun(['node', 'test-script.js'], {
      cwd: 'smoke-test-basic',
    });

    // Secret should NOT appear in plain text
    expect(result.output).not.toContain('super-secret-token-12345');

    // Should contain redaction markers (may vary by platform)
    // Just verify the secret isn't leaked
    expect(result.output).toContain('All env vars loaded correctly');
  });

  test('should redact secrets in interactive scripts', () => {
    const result = varlockRun(['node', 'interactive-script.js'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.output).toContain('Interactive script completed successfully');
    expect(result.output).toContain('PUBLIC_VAR: public-value');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('should preserve stdin functionality with redaction', () => {
    const result = varlockRun(['node', 'stdin-test.js'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.output).toContain('Stdin test completed');
    expect(result.output).toContain('stdin.isTTY');
    expect(result.output).toContain('stdin.readable');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('_VARLOCK_REDACT_STDOUT=false disables redaction', () => {
    const result = varlockRun(['node', 'test-script.js'], {
      cwd: 'smoke-test-basic',
      env: { _VARLOCK_REDACT_STDOUT: 'false' },
    });

    // with redaction explicitly disabled via env var, the secret appears in plain text
    expect(result.output).toContain('super-secret-token-12345');
  });

  test('--no-redact-stdout flag overrides _VARLOCK_REDACT_STDOUT=true', () => {
    const result = varlockRun(['node', 'test-script.js'], {
      cwd: 'smoke-test-basic',
      env: { _VARLOCK_REDACT_STDOUT: 'true' },
    });
    // the env var alone keeps redaction on (output is captured/non-TTY)
    expect(result.output).not.toContain('super-secret-token-12345');

    const overridden = runVarlock(['run', '--no-redact-stdout', '--', 'node', 'test-script.js'], {
      cwd: 'smoke-test-basic',
      env: { _VARLOCK_REDACT_STDOUT: 'true' },
    });
    // the flag takes precedence over the env var, so the secret is shown
    expect(overridden.output).toContain('super-secret-token-12345');
  });
});
