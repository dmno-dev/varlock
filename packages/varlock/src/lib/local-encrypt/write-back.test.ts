import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';

import { writeBackValue } from './write-back';

describe('writeBackValue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-write-back-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates a value in a regular file', () => {
    const filePath = path.join(tmpDir, '.env');
    fs.writeFileSync(filePath, 'FOO=bar\n');
    const result = writeBackValue('FOO', 'varlock("local:xyz")', filePath);
    expect(result).toEqual({ updated: true });
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('FOO=varlock("local:xyz")');
  });

  it('returns missing-source-file when path is undefined or missing', () => {
    expect(writeBackValue('FOO', 'x', undefined)).toEqual({ updated: false, reason: 'missing-source-file' });
    expect(writeBackValue('FOO', 'x', path.join(tmpDir, 'nope.env'))).toEqual({ updated: false, reason: 'missing-source-file' });
  });

  describe.skipIf(process.platform === 'win32')('non-regular source files', () => {
    let fifoWriter: ChildProcess | undefined;

    afterEach(() => {
      fifoWriter?.kill('SIGKILL');
      fifoWriter = undefined;
    });

    it('refuses to write back to a FIFO without reading it', () => {
      const fifoPath = path.join(tmpDir, '.env');
      execSync(`mkfifo "${fifoPath}"`);
      // keep a one-shot writer attached so that if the stat guard ever regresses,
      // readFileSync gets served content and the test fails cleanly (item-not-found)
      // instead of blocking forever on an unserved pipe
      fifoWriter = spawn('bash', ['-c', `printf 'OTHER=x\\n' > "${fifoPath}"`], { stdio: 'ignore' });

      const result = writeBackValue('FOO', 'x', fifoPath);
      expect(result).toEqual({ updated: false, reason: 'non-regular-source-file' });
    });
  });
});
