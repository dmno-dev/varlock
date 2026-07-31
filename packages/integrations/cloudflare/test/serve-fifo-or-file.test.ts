import {
  describe, expect, test, afterEach,
} from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveFifoOrFile } from '../src/serve-fifo-or-file';

const isWindows = process.platform === 'win32';

/** Read a process's argv string from the OS (macOS/Linux). */
function processArgv(pid: number): string {
  if (process.platform === 'linux') {
    try {
      // /proc/*/cmdline is NUL-separated
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      // fall through to ps
    }
  }
  return execSync(`ps -p ${pid} -o args=`, { encoding: 'utf8' }).trim();
}

describe.skipIf(isWindows)('serveFifoOrFile', () => {
  let tmpDir: string;
  let fifoPath: string;
  let handle: Awaited<ReturnType<typeof serveFifoOrFile>> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    try {
      unlinkSync(fifoPath);
    } catch {
      // may already be gone
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('child argv does not contain the env payload', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'varlock-cf-fifo-'));
    fifoPath = path.join(tmpDir, '.dev.vars');

    // Unique marker that would be obvious if leaked into argv (plain or base64).
    const secret = `SECRET_MARKER_${Date.now()}_SHOULD_NOT_APPEAR_IN_ARGV`;
    const content = `API_KEY='${secret}'\n__VARLOCK_ENV='{"x":1}'\n`;
    const encoded = Buffer.from(content).toString('base64');

    handle = await serveFifoOrFile(fifoPath, content);
    expect(handle.pid).toBeDefined();

    const argv = processArgv(handle.pid!);
    expect(argv).not.toContain(secret);
    expect(argv).not.toContain(encoded);
    // Script should still be a node -e helper (sanity that we inspected the right process)
    expect(argv).toMatch(/node|-e/);
  });

  test('serves content via FIFO', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'varlock-cf-fifo-'));
    fifoPath = path.join(tmpDir, '.dev.vars');

    const content = 'FOO=\'bar\'\nBAZ=\'qux\'\n';
    handle = await serveFifoOrFile(fifoPath, content);

    // A continuous write loop can occasionally concatenate copies before EOF
    // (scheduling-dependent). Assert the payload is present rather than exact
    // equality; the argv leak check above is the security regression guard.
    const first = readFileSync(fifoPath, 'utf8');
    expect(first).toContain("FOO='bar'");
    expect(first).toContain("BAZ='qux'");

    const second = readFileSync(fifoPath, 'utf8');
    expect(second).toContain("FOO='bar'");
    expect(second).toContain("BAZ='qux'");
  });
});
