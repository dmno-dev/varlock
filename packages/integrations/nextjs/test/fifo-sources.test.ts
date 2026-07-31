import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as realFs from 'node:fs';

const {
  mockExecSyncVarlock,
  mockWatchFile,
  mockUnwatchFile,
  readFileSyncSpy,
} = vi.hoisted(() => ({
  mockExecSyncVarlock: vi.fn(),
  mockWatchFile: vi.fn(),
  mockUnwatchFile: vi.fn(),
  readFileSyncSpy: vi.fn(),
}));

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: mockExecSyncVarlock,
  VarlockExecError: class VarlockExecError extends Error {},
}));

vi.mock('varlock/env', () => ({
  initVarlockEnv: vi.fn(),
  resetRedactionMap: vi.fn(),
}));

vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: vi.fn(),
}));

// next-env-compat uses `import * as fs from 'fs'`. We mock watchFile/unwatchFile
// and spy on readFileSync — reading a FIFO with no writer blocks forever, so the
// spy returns fake content for FIFO paths instead of delegating (a correct
// implementation never reads them; the assertion below is what actually matters).
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const readFileSync = (...args: Array<any>) => {
    readFileSyncSpy(...args);
    const filePath = args[0];
    if (typeof filePath === 'string' && actual.existsSync(filePath) && !actual.statSync(filePath).isFile()) {
      return 'FAKE_FIFO_CONTENT=1\n';
    }
    return (actual.readFileSync as any)(...args);
  };
  return {
    ...actual,
    readFileSync,
    watchFile: mockWatchFile,
    unwatchFile: mockUnwatchFile,
    default: {
      ...actual,
      readFileSync,
      watchFile: mockWatchFile,
      unwatchFile: mockUnwatchFile,
    },
  };
});

function readFileSyncCallsFor(filePath: string) {
  return readFileSyncSpy.mock.calls.filter((call) => call[0] === filePath);
}

describe.skipIf(process.platform === 'win32')('FIFO env sources (e.g. 1Password Environments)', () => {
  let tmpDir: string;
  let fifoEnvPath: string; // .env — a name Next.js natively watches
  let fifoExtraPath: string; // .env.custom — a name varlock would extra-watch
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.__VARLOCK_ENV;
    delete process.env.__VARLOCK_NEXT_ENV_WATCHER_PID;
    delete process.env.__VARLOCK_NEXT_WARNED_NON_REGULAR_FILES;
    (globalThis as any).__VARLOCK_INTEGRATION_NAME__ = '@varlock/nextjs-integration';
    (globalThis as any).__VARLOCK_INTEGRATION_VERSION__ = '0.0.0-test';

    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'varlock-next-fifo-'));
    realFs.writeFileSync(path.join(tmpDir, '.env.schema'), '# ---\nFOO=bar\n');
    fifoEnvPath = path.join(tmpDir, '.env');
    fifoExtraPath = path.join(tmpDir, '.env.custom');
    execSync(`mkfifo "${fifoEnvPath}" "${fifoExtraPath}"`);

    mockExecSyncVarlock.mockReturnValue({
      stdout: JSON.stringify({
        basePath: tmpDir,
        sources: [
          {
            enabled: true, path: '.env.schema', type: 'file', label: '.env.schema',
          },
          {
            enabled: true, path: '.env', type: 'file', label: '.env',
          },
          {
            enabled: true, path: '.env.custom', type: 'file', label: '.env.custom',
          },
        ],
        settings: {},
        config: { FOO: { value: 'bar', isSensitive: false } },
      }),
      stderr: '',
    });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    realFs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__VARLOCK_ENV;
    delete process.env.__VARLOCK_NEXT_ENV_WATCHER_PID;
    delete process.env.__VARLOCK_NEXT_WARNED_NON_REGULAR_FILES;
  });

  it('never reads or watches FIFO sources during load and reload checks', async () => {
    const { loadEnvConfig } = await import('../src/next-env-compat');

    loadEnvConfig(tmpDir, true);

    // regular extra file (.env.schema) gets watched, FIFO sources do not
    const watchedPaths = mockWatchFile.mock.calls.map((call) => call[0] as string);
    expect(watchedPaths).toContain(path.join(tmpDir, '.env.schema'));
    expect(watchedPaths).not.toContain(fifoEnvPath);
    expect(watchedPaths).not.toContain(fifoExtraPath);

    // the source-state hashing must not have read the FIFOs
    expect(readFileSyncCallsFor(fifoEnvPath)).toHaveLength(0);
    expect(readFileSyncCallsFor(fifoExtraPath)).toHaveLength(0);

    // simulate Next's own .env watcher firing (it always watches .env);
    // the forceReload hash check must still not read the FIFOs
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2000); // get past the 1s reload throttle
      loadEnvConfig(tmpDir, true, console, true);
    } finally {
      vi.useRealTimers();
    }
    expect(readFileSyncCallsFor(fifoEnvPath)).toHaveLength(0);
    expect(readFileSyncCallsFor(fifoExtraPath)).toHaveLength(0);
  });

  it('logs a one-time notice that live reload is disabled for FIFO sources', async () => {
    const { loadEnvConfig } = await import('../src/next-env-compat');

    loadEnvConfig(tmpDir, true);
    loadEnvConfig(tmpDir, true);

    const fifoNoticeLogs = consoleLogSpy.mock.calls.filter(
      (call: Array<any>) => String(call[0]).includes('.env.custom') && String(call[0]).includes('live reload is disabled'),
    );
    expect(fifoNoticeLogs).toHaveLength(1);
  });
});
