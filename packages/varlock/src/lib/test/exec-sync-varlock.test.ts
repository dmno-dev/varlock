import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const childProcess = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => childProcess);

import { execSyncVarlock } from '../exec-sync-varlock';

function makeNotFoundError() {
  const err = new Error('not found') as Error & { status: number };
  err.status = 127;
  return err;
}

describe('execSyncVarlock', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('falls back to the package-local CLI when node_modules/.bin is missing', () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), 'varlock-exec-'));
    const realExistsSync = fs.existsSync.bind(fs);
    const existsSync = vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return String(filePath).startsWith(tempDir) && realExistsSync(filePath);
    });

    try {
      const packageDir = join(tempDir, 'node_modules', 'varlock');
      const appDir = join(tempDir, 'app');
      const cliPath = join(packageDir, 'dist', 'cli', 'cli-executable.js');
      fs.mkdirSync(dirname(cliPath), { recursive: true });
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(cliPath, '');

      childProcess.execSync.mockImplementation(() => {
        throw makeNotFoundError();
      });
      childProcess.execFileSync.mockReturnValue(Buffer.from('ok'));

      const result = execSyncVarlock('load --format json-full', {
        callerDir: join(packageDir, 'dist'),
        cwd: appDir,
      });

      expect(result).toBe('ok');
      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        process.execPath,
        [cliPath, 'load', '--format', 'json-full'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    } finally {
      existsSync.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
