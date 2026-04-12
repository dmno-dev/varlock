import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadVarlockEnvGraph } from '../load-graph';

describe('loadVarlockEnvGraph', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-load-graph-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('single entryFilePath loads from that directory', async () => {
    const dir = path.join(tempDir, 'envs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env.schema'), 'MY_VAR=hello\n');

    const graph = await loadVarlockEnvGraph({
      entryFilePaths: [path.join(tempDir, 'envs/')],
    });
    await graph.resolveEnvValues();

    expect(graph.configSchema.MY_VAR.resolvedValue).toBe('hello');
  });

  it('multiple entryFilePaths loads from all directories', async () => {
    const dir1 = path.join(tempDir, 'path1');
    const dir2 = path.join(tempDir, 'path2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir1, '.env.schema'), 'ITEM1=from-dir1\n');
    fs.writeFileSync(path.join(dir2, '.env.schema'), 'ITEM2=from-dir2\n');

    const graph = await loadVarlockEnvGraph({
      entryFilePaths: [`${dir1}/`, `${dir2}/`],
    });
    await graph.resolveEnvValues();

    expect(graph.configSchema.ITEM1.resolvedValue).toBe('from-dir1');
    expect(graph.configSchema.ITEM2.resolvedValue).toBe('from-dir2');
  });

  it('later paths have higher precedence', async () => {
    const dir1 = path.join(tempDir, 'base');
    const dir2 = path.join(tempDir, 'overrides');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir1, '.env.schema'), 'SHARED=from-base\n');
    fs.writeFileSync(path.join(dir2, '.env.schema'), 'SHARED=from-override\n');

    const graph = await loadVarlockEnvGraph({
      entryFilePaths: [`${dir1}/`, `${dir2}/`],
    });
    await graph.resolveEnvValues();

    expect(graph.configSchema.SHARED.resolvedValue).toBe('from-override');
  });

  it('throws when an entry path does not exist', () => {
    expect(() => loadVarlockEnvGraph({
      entryFilePaths: [path.join(tempDir, 'nonexistent/')],
    })).toThrow(/does not exist/);
  });

  it('empty entryFilePaths array falls through to package.json / cwd', async () => {
    fs.writeFileSync(path.join(tempDir, '.env.schema'), 'DEFAULT_VAR=from-cwd\n');

    const graph = await loadVarlockEnvGraph({
      entryFilePaths: [],
    });
    await graph.resolveEnvValues();

    expect(graph.configSchema.DEFAULT_VAR.resolvedValue).toBe('from-cwd');
  });

  it('entryFilePaths overrides package.json loadPath', async () => {
    const pkgDir = path.join(tempDir, 'pkg-path');
    const cliDir = path.join(tempDir, 'cli-path');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, '.env.schema'), 'SOURCE=package-json\n');
    fs.writeFileSync(path.join(cliDir, '.env.schema'), 'SOURCE=cli-flag\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'test',
      varlock: { loadPath: './pkg-path/' },
    }));

    const graph = await loadVarlockEnvGraph({
      entryFilePaths: [`${cliDir}/`],
    });
    await graph.resolveEnvValues();

    expect(graph.configSchema.SOURCE.resolvedValue).toBe('cli-flag');
  });
});
