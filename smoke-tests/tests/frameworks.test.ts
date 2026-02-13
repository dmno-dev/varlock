import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { varlockLoad } from '../helpers/run-varlock.js';

const SMOKE_TESTS_DIR = join(import.meta.dirname, '..');

describe('Astro Integration', () => {
  beforeAll(() => {
    // Unset cached env to ensure clean test
    delete process.env.__VARLOCK_ENV;

    const astroDir = join(SMOKE_TESTS_DIR, 'smoke-test-astro');

    // Install dependencies
    execSync('pnpm install --silent', { cwd: astroDir, stdio: 'inherit' });

    // Generate types
    varlockLoad({ cwd: 'smoke-test-astro' });

    // Build
    execSync('pnpm run build', { cwd: astroDir, stdio: 'inherit' });
  });

  test('should build successfully', () => {
    const distPath = join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html');
    expect(existsSync(distPath)).toBe(true);
  });

  test('should inject public env vars', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html'),
      'utf-8',
    );

    expect(html).toContain('api.example.com');
  });

  test('should make secrets accessible at build time', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html'),
      'utf-8',
    );

    expect(html).toContain('Secret accessible on server: Yes');
  });

  test('should NOT leak secret values into output', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html'),
      'utf-8',
    );

    expect(html).not.toContain('test-api-key-secret-123');
  });

  test('should handle empty secrets correctly', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html'),
      'utf-8',
    );

    expect(html).toContain('Empty secret is empty: Yes');
  });

  test('should render success message', () => {
    const html = readFileSync(
      join(SMOKE_TESTS_DIR, 'smoke-test-astro/dist/index.html'),
      'utf-8',
    );

    expect(html).toContain('Build succeeded with varlock integration');
  });
});

describe('Next.js Integration', () => {
  beforeAll(() => {
    // Unset cached env to ensure clean test
    delete process.env.__VARLOCK_ENV;

    const nextDir = join(SMOKE_TESTS_DIR, 'smoke-test-nextjs');

    // Install dependencies
    execSync('pnpm install --silent', { cwd: nextDir, stdio: 'inherit' });

    // Generate types
    varlockLoad({ cwd: 'smoke-test-nextjs' });

    // Build
    execSync('pnpm run build', { cwd: nextDir, stdio: 'inherit' });
  });

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
