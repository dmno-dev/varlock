import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectWorkspaceRoot } from '../workspace-utils';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-workspace-root-test-'));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** writes files (empty unless contents given) at paths relative to tempDir, creating dirs as needed */
function writeTree(files: Array<string> | Record<string, string>) {
  const entries = Array.isArray(files) ? files.map((f) => [f, ''] as const) : Object.entries(files);
  for (const [relPath, contents] of entries) {
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }
}
function subDir(relPath: string) {
  const fullPath = path.join(tempDir, relPath);
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

describe('detectWorkspaceRoot', () => {
  test('returns undefined when there is nothing to go on', () => {
    expect(detectWorkspaceRoot({ cwd: subDir('packages/foo') })).toBeUndefined();
  });

  test('detects a uv (python) workspace root from a member package', () => {
    // the layout from issue #998
    writeTree(['uv.lock', 'pyproject.toml', '.env.schema', 'packages/foo/pyproject.toml', 'packages/foo/.env.schema']);
    const result = detectWorkspaceRoot({ cwd: path.join(tempDir, 'packages/foo') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('uv.lock');
    expect(result?.ecosystem).toBe('python');
  });

  test.each([
    ['poetry.lock', 'python'],
    ['pdm.lock', 'python'],
    ['pixi.lock', 'python'],
    ['Pipfile.lock', 'python'],
    ['requirements.lock', 'python'],
    ['Cargo.lock', 'rust'],
    ['go.work', 'go'],
    ['composer.lock', 'php'],
    ['Gemfile.lock', 'ruby'],
    ['mix.lock', 'elixir'],
    ['settings.gradle', 'jvm'],
    ['settings.gradle.kts', 'jvm'],
    ['pom.xml', 'jvm'],
    ['global.json', 'dotnet'],
    ['Directory.Build.props', 'dotnet'],
    ['MODULE.bazel', 'polyglot'],
    ['WORKSPACE', 'polyglot'],
    ['pants.toml', 'polyglot'],
    ['pnpm-lock.yaml', 'js'],
    ['pnpm-workspace.yaml', 'js'],
    ['turbo.json', 'js'],
  ])('detects %s as a workspace root marker', (markerFile, ecosystem) => {
    writeTree([markerFile]);
    const result = detectWorkspaceRoot({ cwd: subDir('packages/foo') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe(markerFile);
    expect(result?.ecosystem).toBe(ecosystem);
  });

  test('detects a .NET solution file (named after the solution)', () => {
    writeTree(['MyCompany.Services.sln']);
    const result = detectWorkspaceRoot({ cwd: subDir('src/api') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('MyCompany.Services.sln');
    expect(result?.ecosystem).toBe('dotnet');
  });

  test('falls back to the git root when no ecosystem marker is found', () => {
    writeTree(['.git/HEAD']);
    const result = detectWorkspaceRoot({ cwd: subDir('services/api') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('.git');
    expect(result?.ecosystem).toBe('vcs');
  });

  test('handles a .git file (worktrees and submodules)', () => {
    writeTree({ '.git': 'gitdir: /elsewhere/.git/worktrees/wt' });
    expect(detectWorkspaceRoot({ cwd: subDir('packages/foo') })?.rootPath).toBe(tempDir);
  });

  test('takes the outermost marker, not the nearest one', () => {
    // ruby/php/dotnet monorepos often carry a per-package lockfile as well as a root one
    writeTree(['Gemfile.lock', 'services/api/Gemfile.lock']);
    const result = detectWorkspaceRoot({ cwd: path.join(tempDir, 'services/api') });
    expect(result?.rootPath).toBe(tempDir);
  });

  test('does not walk above the VCS root', () => {
    // marker above the repo root belongs to something else (or the user's home dir)
    writeTree(['uv.lock', 'repo/.git/HEAD', 'repo/packages/foo/pyproject.toml']);
    const result = detectWorkspaceRoot({ cwd: path.join(tempDir, 'repo/packages/foo') });
    expect(result?.rootPath).toBe(path.join(tempDir, 'repo'));
    expect(result?.marker).toBe('.git');
  });

  test('prefers a marker at the VCS root over the VCS marker itself', () => {
    writeTree(['.git/HEAD', 'uv.lock']);
    const result = detectWorkspaceRoot({ cwd: subDir('packages/foo') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('uv.lock');
  });

  test('prefers the VCS root over a nested package marker', () => {
    writeTree(['.git/HEAD', 'services/api/Cargo.lock']);
    const result = detectWorkspaceRoot({ cwd: subDir('services/api') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('.git');
  });

  test('takes the outermost marker inside the repo, ignoring nested ones', () => {
    // a nested JS project inside a python monorepo
    writeTree(['uv.lock', '.git/HEAD', 'services/web/package-lock.json']);
    const result = detectWorkspaceRoot({ cwd: subDir('services/web') });
    expect(result?.rootPath).toBe(tempDir);
    expect(result?.marker).toBe('uv.lock');
  });

  test('returns the cwd itself when the marker is there', () => {
    writeTree(['go.work']);
    expect(detectWorkspaceRoot({ cwd: tempDir })?.rootPath).toBe(tempDir);
  });
});
