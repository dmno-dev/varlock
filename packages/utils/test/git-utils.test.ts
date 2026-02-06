import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { checkIsFileGitIgnored } from '../src/git-utils';

describe('checkIsFileGitIgnored', () => {
  const testDir = '/tmp/git-utils-test-with spaces';
  const testFile = path.join(testDir, 'test-file.txt');
  const ignoredFile = path.join(testDir, 'ignored-file.txt');

  beforeAll(() => {
    // Clean up any previous test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore if it doesn't exist
    }

    // Create test directory with spaces in the name
    mkdirSync(testDir, { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: testDir });
    execSync('git config user.email "test@test.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });

    // Create .gitignore file
    writeFileSync(path.join(testDir, '.gitignore'), 'ignored-file.txt\n');

    // Create test files
    writeFileSync(testFile, 'test content');
    writeFileSync(ignoredFile, 'ignored content');
  });

  afterAll(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  test('should return false for non-ignored file in path with spaces', async () => {
    const result = await checkIsFileGitIgnored(testFile);
    expect(result).toBe(false);
  });

  test('should return true for ignored file in path with spaces', async () => {
    const result = await checkIsFileGitIgnored(ignoredFile);
    expect(result).toBe(true);
  });

  test('should return false for non-existent git repo with warning', async () => {
    const nonGitPath = path.join('/tmp/non-git-dir-with spaces', 'file.txt');
    mkdirSync(path.dirname(nonGitPath), { recursive: true });
    writeFileSync(nonGitPath, 'content');

    const result = await checkIsFileGitIgnored(nonGitPath, true);
    expect(result).toBe(false);

    // Cleanup
    rmSync(path.dirname(nonGitPath), { recursive: true, force: true });
  });
});
