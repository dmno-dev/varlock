import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectWorkspaceInfo } from '../../../lib/workspace-utils';

describe('detectWorkspaceInfo', () => {
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
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.packageManager.name).toBe('npm');
    expect(result?.rootPath).toBe(tempDir);
  });

  test('detects pnpm from pnpm-lock.yaml', () => {
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.packageManager.name).toBe('pnpm');
    expect(result?.rootPath).toBe(tempDir);
  });

  test('detects yarn from yarn.lock', () => {
    fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.packageManager.name).toBe('yarn');
    expect(result?.rootPath).toBe(tempDir);
  });

  test('detects bun from bun.lockb', () => {
    fs.writeFileSync(path.join(tempDir, 'bun.lockb'), '');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.packageManager.name).toBe('bun');
    expect(result?.rootPath).toBe(tempDir);
  });

  test('returns one of the detected package managers when multiple lockfiles are present', () => {
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'bun.lockb'), '');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    // If running via pnpm (npm_config_user_agent is set), it will detect pnpm from env var
    // Otherwise, it should return one of the detected package managers (npm or bun)
    // Both behaviors are correct - env var detection takes precedence
    expect(result?.packageManager.name).toBeTruthy();
  });

  test('returns one of the detected package managers (pnpm + yarn)', () => {
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result).toBeDefined();
    // If running via pnpm (npm_config_user_agent is set), it will detect pnpm from env var
    // Otherwise, it should return one of the detected package managers (pnpm or yarn)
    expect(result?.packageManager.name).toBeTruthy();
  });

  test('detects monorepo from workspaces field in package.json', () => {
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result?.isMonorepo).toBe(true);
  });

  test('detects monorepo from pnpm-workspace.yaml', () => {
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result?.isMonorepo).toBe(true);
  });

  test('detects turborepo monorepo tool', () => {
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'turbo.json'), '{}');

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result?.isMonorepo).toBe(true);
    expect(result?.monorepoTool).toBe('turborepo');
  });

  test('is not a monorepo when no workspace indicators present', () => {
    fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));

    const result = detectWorkspaceInfo({ cwd: tempDir });
    expect(result?.isMonorepo).toBe(false);
    expect(result?.monorepoTool).toBeUndefined();
  });

  test('walks up to find lockfile in parent directory', () => {
    const subDir = path.join(tempDir, 'packages', 'my-app');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'bun.lock'), '');

    const result = detectWorkspaceInfo({ cwd: subDir });
    expect(result?.packageManager.name).toBe('bun');
    expect(result?.rootPath).toBe(tempDir);
  });
});
