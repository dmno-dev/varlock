import { describe, test, expect } from 'vitest';
import { varlockRun } from '../helpers/run-varlock.js';
import { execSync } from 'node:child_process';
import { writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Runtime Support', () => {
  test('should work with Node.js', () => {
    const result = varlockRun(['node', '--version'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('v');
  });

  test.skipIf(!hasBun())('should work with Bun', () => {
    const result = varlockRun(['bun', 'test-script.js'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.output).toContain('NODE_ENV: test');
    expect(result.output).toContain('All env vars loaded correctly');
    expect(result.output).not.toContain('super-secret-token-12345');
  });

  test('should handle command not found errors', () => {
    const result = varlockRun(['nonexistent-command-xyz'], {
      cwd: 'smoke-test-basic',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toMatch(/command|not found|enoent/);
  });

  test.skipIf(process.platform === 'win32')('should execute shebang scripts', () => {
    // Create a temp shebang script for testing
    const testScript = join(SMOKE_TESTS_DIR, 'smoke-test-basic', 'shebang-test.js');

    writeFileSync(testScript, '#!/usr/bin/env node\nconsole.log("Shebang works");');
    chmodSync(testScript, 0o755);

    try {
      const result = varlockRun(['./shebang-test.js'], {
        cwd: 'smoke-test-basic',
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Shebang works');
    } finally {
      unlinkSync(testScript);
    }
  });
});

