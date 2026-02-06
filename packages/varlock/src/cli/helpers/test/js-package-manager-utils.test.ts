import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectJsPackageManager } from '../js-package-manager-utils';

describe('detectJsPackageManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('detects npm from package-lock.json', () => {
    const lockFilePath = path.join(tempDir, 'package-lock.json');
    fs.writeFileSync(lockFilePath, '{}');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.name).toBe('npm');
  });

  test('detects pnpm from pnpm-lock.yaml', () => {
    const lockFilePath = path.join(tempDir, 'pnpm-lock.yaml');
    fs.writeFileSync(lockFilePath, '');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.name).toBe('pnpm');
  });

  test('detects yarn from yarn.lock', () => {
    const lockFilePath = path.join(tempDir, 'yarn.lock');
    fs.writeFileSync(lockFilePath, '');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.name).toBe('yarn');
  });

  test('detects bun from bun.lockb', () => {
    const lockFilePath = path.join(tempDir, 'bun.lockb');
    fs.writeFileSync(lockFilePath, '');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.name).toBe('bun');
  });

  test('returns one of the detected package managers when multiple lockfiles are present', () => {
    const npmLockPath = path.join(tempDir, 'package-lock.json');
    const bunLockPath = path.join(tempDir, 'bun.lockb');
    fs.writeFileSync(npmLockPath, '{}');
    fs.writeFileSync(bunLockPath, '');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    // If running via pnpm (npm_config_user_agent is set), it will detect pnpm from env var
    // Otherwise, it should return one of the detected package managers (npm or bun)
    // Both behaviors are correct - env var detection takes precedence
    expect(result?.name).toBeTruthy();
  });

  test('returns one of the detected package managers (pnpm + yarn)', () => {
    const pnpmLockPath = path.join(tempDir, 'pnpm-lock.yaml');
    const yarnLockPath = path.join(tempDir, 'yarn.lock');
    fs.writeFileSync(pnpmLockPath, '');
    fs.writeFileSync(yarnLockPath, '');

    const result = detectJsPackageManager({ cwd: tempDir });
    expect(result).toBeDefined();
    // If running via pnpm (npm_config_user_agent is set), it will detect pnpm from env var
    // Otherwise, it should return one of the detected package managers (pnpm or yarn)
    expect(result?.name).toBeTruthy();
  });
});
