import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveWorkspaceRoot } from '../flatten.command';

let tempDir: string;

beforeEach(() => {
  // realpath so comparisons match (macOS tmpdir is a symlink)
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-flatten-cmd-test-')));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeTree(...relPaths: Array<string>) {
  for (const relPath of relPaths) {
    const fullPath = path.join(tempDir, relPath);
    if (relPath.endsWith('/')) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, '');
    }
  }
}

describe('resolveWorkspaceRoot', () => {
  test('detects a non-JS workspace root from a member package', () => {
    makeTree('uv.lock', 'packages/foo/.env.schema');
    const result = resolveWorkspaceRoot({ packageDir: path.join(tempDir, 'packages/foo') });
    expect(result).toEqual({ workspaceRootPath: tempDir, source: 'detected', marker: 'uv.lock' });
  });

  test('falls back to the package dir when nothing is detected', () => {
    makeTree('packages/foo/.env.schema');
    const packageDir = path.join(tempDir, 'packages/foo');
    expect(resolveWorkspaceRoot({ packageDir })).toEqual({ workspaceRootPath: packageDir, source: 'fallback' });
  });

  test('explicit root wins over detection', () => {
    makeTree('uv.lock', 'packages/foo/.env.schema');
    const result = resolveWorkspaceRoot({
      packageDir: path.join(tempDir, 'packages/foo'),
      explicitRoot: '..',
    });
    expect(result).toEqual({ workspaceRootPath: path.join(tempDir, 'packages'), source: 'explicit' });
  });

  test('throws when the explicit root does not exist', () => {
    makeTree('packages/foo/.env.schema');
    expect(() => resolveWorkspaceRoot({
      packageDir: path.join(tempDir, 'packages/foo'),
      explicitRoot: '../../nope',
    })).toThrow('does not exist');
  });

  test('throws when the explicit root does not contain the package dir', () => {
    makeTree('packages/foo/.env.schema', 'other/');
    expect(() => resolveWorkspaceRoot({
      packageDir: path.join(tempDir, 'packages/foo'),
      explicitRoot: '../../other',
    })).toThrow('must contain the current directory');
  });
});
