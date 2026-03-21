import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readVarlockPackageJsonConfig } from '../package-json-config';

describe('readVarlockPackageJsonConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-pkg-json-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns undefined when no package.json exists', () => {
    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result).toBeUndefined();
  });

  test('returns undefined when package.json has no varlock key', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));

    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result).toBeUndefined();
  });

  test('returns varlock config when package.json has a varlock key', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      varlock: { loadPath: './envs/' },
    }));

    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.loadPath).toBe('./envs/');
  });

  test('returns varlock config with loadPath set to a file path', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      varlock: { loadPath: './config/.env.schema' },
    }));

    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result?.loadPath).toBe('./config/.env.schema');
  });

  test('finds package.json in a parent directory', () => {
    const subDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      varlock: { loadPath: './envs/' },
    }));

    const result = readVarlockPackageJsonConfig({ cwd: subDir });
    expect(result?.loadPath).toBe('./envs/');
  });

  test('stops at the first package.json found even if it has no varlock key', () => {
    // parent has varlock config, child has package.json without varlock
    const subDir = path.join(tempDir, 'packages', 'my-app');
    fs.mkdirSync(subDir, { recursive: true });

    // child package.json WITHOUT varlock key
    fs.writeFileSync(path.join(subDir, 'package.json'), JSON.stringify({ name: 'my-app' }));

    // parent package.json WITH varlock key
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'root',
      varlock: { loadPath: './envs/' },
    }));

    // should stop at the child package.json and return undefined
    const result = readVarlockPackageJsonConfig({ cwd: subDir });
    expect(result).toBeUndefined();
  });

  test('returns undefined when varlock key is not an object', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      varlock: 'invalid',
    }));

    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result).toBeUndefined();
  });

  test('returns varlock config without loadPath when varlock key is empty object', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      varlock: {},
    }));

    const result = readVarlockPackageJsonConfig({ cwd: tempDir });
    expect(result).toBeDefined();
    expect(result?.loadPath).toBeUndefined();
  });
});
