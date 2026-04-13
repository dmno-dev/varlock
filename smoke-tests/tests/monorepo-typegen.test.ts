import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { varlockLoad } from '../helpers/run-varlock.js';

const MONOREPO_DIR = join(import.meta.dirname, '..', 'smoke-test-monorepo');
const PKG_A_DIR = join(MONOREPO_DIR, 'packages', 'pkg-a');
const PKG_B_DIR = join(MONOREPO_DIR, 'packages', 'pkg-b');

function tsc(cwd: string) {
  try {
    const output = execSync('npx tsc --noEmit', {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { exitCode: 0, output };
  } catch (error: any) {
    return {
      exitCode: error.status || 1,
      output: (error.stdout || '') + (error.stderr || ''),
    };
  }
}

describe('monorepo type generation', () => {
  beforeAll(() => {
    // Clean and regenerate env.d.ts for both packages
    const envDtsA = join(PKG_A_DIR, 'env.d.ts');
    const envDtsB = join(PKG_B_DIR, 'env.d.ts');
    if (existsSync(envDtsA)) rmSync(envDtsA);
    if (existsSync(envDtsB)) rmSync(envDtsB);

    const resultA = varlockLoad({ cwd: 'smoke-test-monorepo/packages/pkg-a' });
    expect(resultA.exitCode).toBe(0);
    expect(existsSync(envDtsA)).toBe(true);

    const resultB = varlockLoad({ cwd: 'smoke-test-monorepo/packages/pkg-b' });
    expect(resultB.exitCode).toBe(0);
    expect(existsSync(envDtsB)).toBe(true);
  });

  test('pkg-a type-checks successfully on its own', () => {
    const result = tsc(PKG_A_DIR);
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('monorepo root tsconfig type-checks with both packages env.d.ts visible', () => {
    // When a root tsconfig includes all packages (common in monorepos),
    // both env.d.ts augmentations are visible to tsc. The inlined interface
    // properties must merge additively without conflicting.
    const result = tsc(MONOREPO_DIR);
    expect(result.output).not.toContain("Property 'PORT' does not exist");
    expect(result.output).not.toContain("Property 'REDIS_URL' does not exist");
    expect(result.output).not.toContain("Property 'API_KEY' does not exist");
    expect(result.exitCode).toBe(0);
  });

  test('generated env.d.ts uses unique type aliases to avoid cross-package collisions', () => {
    const envDtsA = readFileSync(join(PKG_A_DIR, 'env.d.ts'), 'utf-8');
    const envDtsB = readFileSync(join(PKG_B_DIR, 'env.d.ts'), 'utf-8');

    // Should NOT reference CoercedEnvSchema or EnvSchemaAsStrings directly in augmentation blocks
    expect(envDtsA).not.toContain('extends Readonly<CoercedEnvSchema>');
    expect(envDtsB).not.toContain('extends Readonly<CoercedEnvSchema>');
    expect(envDtsA).not.toContain('extends EnvSchemaAsStrings');
    expect(envDtsB).not.toContain('extends EnvSchemaAsStrings');

    // Should use unique hashed aliases instead
    expect(envDtsA).toMatch(/_CoercedEnvSchema_[0-9a-f]+/);
    expect(envDtsB).toMatch(/_CoercedEnvSchema_[0-9a-f]+/);

    // The two packages should have different hashes (different schemas)
    const hashA = envDtsA.match(/_CoercedEnvSchema_([0-9a-f]+)/)![1];
    const hashB = envDtsB.match(/_CoercedEnvSchema_([0-9a-f]+)/)![1];
    expect(hashA).not.toBe(hashB);
  });
});
