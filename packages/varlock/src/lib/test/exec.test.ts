import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../exec.js';

/**
 * Collect all data from a Readable stream into a string.
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Array<Buffer | string> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

describe('exec', () => {
  it('should forward child stdout with piped stdio', async () => {
    // This test validates that stdout data is fully available when the
    // Promise resolves. The bug (exit vs close) would cause this to race:
    // on a slow machine or Windows the data events might not have fired
    // by the time process.exit() is called after `await commandProcess`.
    const childProcess = exec('node', ['-p', '1+1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdoutData = childProcess.stdout ? streamToString(childProcess.stdout) : Promise.resolve('');

    const result = await childProcess;
    expect(result.exitCode).toBe(0);

    // All pipe data must be available once the Promise resolves (close event)
    const output = await stdoutData;
    expect(stripVTControlCharacters(output).trim()).toBe('2');
  });

  it('should propagate non-zero exit code', async () => {
    let exitCode: number;
    try {
      await exec('node', ['-e', 'process.exit(42)'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      exitCode = 0;
    } catch (error: any) {
      exitCode = error.exitCode;
    }
    expect(exitCode).toBe(42);
  });

  it('should forward child stderr with piped stdio', async () => {
    const childProcess = exec('node', ['-e', 'process.stderr.write("err-output\\n")'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderrData = childProcess.stderr ? streamToString(childProcess.stderr) : Promise.resolve('');

    const result = await childProcess;
    expect(result.exitCode).toBe(0);

    const output = await stderrData;
    expect(output.trim()).toBe('err-output');
  });

  it('should resolve with inherited stdio', async () => {
    const result = await exec('node', ['-e', 'process.exit(0)'], {
      stdio: 'inherit',
    });
    expect(result.exitCode).toBe(0);
  });

  it('should resolve after child fully runs (not prematurely)', async () => {
    const startMs = Date.now();
    const result = await exec('node', ['-e', 'setTimeout(() => {}, 300)'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const elapsedMs = Date.now() - startMs;
    expect(result.exitCode).toBe(0);
    // The child runs a 300ms setTimeout, so the Promise must not resolve before
    // the child exits. We assert ≥200ms (100ms slack for slow/loaded CI runners)
    // to avoid flakiness while still catching a premature resolve (e.g. <50ms).
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('should not read whole PATH binaries when probing shebangs', async () => {
    // Regression: readShebang used readFileSync on the entire file. Resolving a
    // bare command like `node` (~100MB+ binary) allocated hundreds of MiB.
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'varlock-shebang-'));
    const binName = 'varlock-shebang-probe';
    const binPath = join(dir, binName);
    // Large file with a shebang script that exits before any padding is parsed.
    // findCommand must probe this via readShebang without loading all 32 MiB.
    const payload = Buffer.concat([
      Buffer.from('#!/bin/sh\necho shebang-ok\nexit 0\n'),
      Buffer.alloc(32 * 1024 * 1024, 0x00),
    ]);
    writeFileSync(binPath, payload);
    chmodSync(binPath, 0o755);

    const before = process.memoryUsage().rss;
    const childProcess = exec(binName, [], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH || ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutData = childProcess.stdout ? streamToString(childProcess.stdout) : Promise.resolve('');
    const result = await childProcess;
    const after = process.memoryUsage().rss;
    rmSync(dir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect((await stdoutData).trim()).toBe('shebang-ok');
    // Allow some allocator noise, but must not retain anything like the 32MiB file
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
  }, 15_000);
});
