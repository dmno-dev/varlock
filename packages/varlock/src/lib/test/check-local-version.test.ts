import {
  describe, it, expect, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkLocalVersionMismatch } from '../check-local-version';

describe('checkLocalVersionMismatch', () => {
  const tmpDirs: Array<string> = [];

  function createTempProject(localVarlockVersion?: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-test-'));
    tmpDirs.push(tmpDir);

    if (localVarlockVersion) {
      const varlockDir = path.join(tmpDir, 'node_modules', 'varlock');
      fs.mkdirSync(varlockDir, { recursive: true });
      fs.writeFileSync(
        path.join(varlockDir, 'package.json'),
        JSON.stringify({ name: 'varlock', version: localVarlockVersion }),
      );
    }

    return tmpDir;
  }

  function withCwd(dir: string, fn: () => void) {
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      fn();
    } finally {
      process.chdir(originalCwd);
    }
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('should return undefined when no node_modules/varlock exists', () => {
    const tmpDir = createTempProject();
    withCwd(tmpDir, () => {
      expect(checkLocalVersionMismatch('1.0.0')).toBeUndefined();
    });
  });

  it('should return undefined when versions match', () => {
    const tmpDir = createTempProject('1.0.0');
    withCwd(tmpDir, () => {
      expect(checkLocalVersionMismatch('1.0.0')).toBeUndefined();
    });
  });

  it('should return a warning when versions differ', () => {
    const tmpDir = createTempProject('0.6.3');
    withCwd(tmpDir, () => {
      const result = checkLocalVersionMismatch('0.4.0');
      expect(result).toBeDefined();
      expect(result).toContain('0.4.0');
      expect(result).toContain('0.6.3');
      expect(result).toContain('mismatch');
    });
  });

  it('should include the standalone binary version in the warning', () => {
    const tmpDir = createTempProject('2.0.0');
    withCwd(tmpDir, () => {
      const result = checkLocalVersionMismatch('1.0.0');
      expect(result).toContain('Standalone binary version: 1.0.0');
    });
  });

  it('should include the local installed version in the warning', () => {
    const tmpDir = createTempProject('2.0.0');
    withCwd(tmpDir, () => {
      const result = checkLocalVersionMismatch('1.0.0');
      expect(result).toContain('Local installed version:   2.0.0');
    });
  });

  it('should suggest using locally installed version', () => {
    const tmpDir = createTempProject('2.0.0');
    withCwd(tmpDir, () => {
      const result = checkLocalVersionMismatch('1.0.0');
      expect(result).toContain('npx varlock');
    });
  });

  it('should find node_modules in parent directory', () => {
    const tmpDir = createTempProject('2.0.0');
    const subDir = path.join(tmpDir, 'src', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    withCwd(subDir, () => {
      const result = checkLocalVersionMismatch('1.0.0');
      expect(result).toBeDefined();
      expect(result).toContain('2.0.0');
    });
  });

  it('should handle malformed package.json gracefully', () => {
    const tmpDir = createTempProject();
    const varlockDir = path.join(tmpDir, 'node_modules', 'varlock');
    fs.mkdirSync(varlockDir, { recursive: true });
    fs.writeFileSync(path.join(varlockDir, 'package.json'), 'not valid json');
    withCwd(tmpDir, () => {
      expect(checkLocalVersionMismatch('1.0.0')).toBeUndefined();
    });
  });

  it('should handle package.json without version field', () => {
    const tmpDir = createTempProject();
    const varlockDir = path.join(tmpDir, 'node_modules', 'varlock');
    fs.mkdirSync(varlockDir, { recursive: true });
    fs.writeFileSync(path.join(varlockDir, 'package.json'), JSON.stringify({ name: 'varlock' }));
    withCwd(tmpDir, () => {
      expect(checkLocalVersionMismatch('1.0.0')).toBeUndefined();
    });
  });
});
