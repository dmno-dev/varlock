import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { varlockLoad } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

// On Windows, stdio: 'inherit' can cause hangs. Use 'pipe' for stdin but inherit stdout/stderr
const isWindows = platform() === 'win32';
const execOptions = {
  stdio: isWindows ? ['pipe', 'inherit', 'inherit'] as const : 'inherit' as const,
};

describe('Next.js Integration', () => {
  beforeAll(() => {
    // Unset cached env to ensure clean test
    delete process.env.__VARLOCK_ENV;

    const nextDir = join(SMOKE_TESTS_DIR, 'smoke-test-nextjs');

    // Generate types
    varlockLoad({ cwd: 'smoke-test-nextjs' });

    // Build
    execSync('pnpm run build', { cwd: nextDir, ...execOptions });
  }, 120000); // Increased timeout for Windows - Next.js builds can be slower

  test('should build successfully', () => {
    const outPath = join(SMOKE_TESTS_DIR, 'smoke-test-nextjs/out');
    expect(existsSync(outPath)).toBe(true);
  });

  test('should generate index.html', () => {
    const indexPath = join(SMOKE_TESTS_DIR, 'smoke-test-nextjs/out/index.html');
    expect(existsSync(indexPath)).toBe(true);
  });

  test('should inject public env vars', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-nextjs/out/index.html'),
      'utf-8',
    );

    expect(html).toContain('api.example.com');
  });

  test('should NOT leak sensitive values', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-nextjs/out/index.html'),
      'utf-8',
    );

    expect(html).not.toContain('postgresql');
  });

  test('should render success message', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-nextjs/out/index.html'),
      'utf-8',
    );

    expect(html).toContain('Build succeeded with varlock integration');
  });
});
