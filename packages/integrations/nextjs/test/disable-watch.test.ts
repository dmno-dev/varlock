import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realFs from 'node:fs';

const {
  mockExecSyncVarlock,
  mockInitVarlockEnv,
  mockPatchGlobalConsole,
  mockWatchFile,
  mockUnwatchFile,
} = vi.hoisted(() => ({
  mockExecSyncVarlock: vi.fn(),
  mockInitVarlockEnv: vi.fn(),
  mockPatchGlobalConsole: vi.fn(),
  mockWatchFile: vi.fn(),
  mockUnwatchFile: vi.fn(),
}));

vi.mock('varlock/exec-sync-varlock', () => ({
  execSyncVarlock: mockExecSyncVarlock,
  VarlockExecError: class VarlockExecError extends Error {},
}));

vi.mock('varlock/env', () => ({
  initVarlockEnv: mockInitVarlockEnv,
  resetRedactionMap: vi.fn(),
}));

vi.mock('varlock/patch-console', () => ({
  patchGlobalConsole: mockPatchGlobalConsole,
}));

// next-env-compat uses `import * as fs from 'fs'`.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    watchFile: mockWatchFile,
    unwatchFile: mockUnwatchFile,
    default: {
      ...actual,
      watchFile: mockWatchFile,
      unwatchFile: mockUnwatchFile,
    },
  };
});

const DISABLE_WATCH_ENV_KEY = '__VARLOCK_NEXT_DISABLE_WATCH';
const WATCHER_OWNER_ENV_KEY = '__VARLOCK_NEXT_ENV_WATCHER_PID';

describe('disableWatch teardown', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.__VARLOCK_ENV;
    delete process.env[DISABLE_WATCH_ENV_KEY];
    delete process.env[WATCHER_OWNER_ENV_KEY];
    vi.clearAllMocks();

    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'varlock-next-disable-watch-'));
    // Early enableExtraFileWatchers([], ...) always watches rootDir/.env.schema
    realFs.writeFileSync(path.join(tmpDir, '.env.schema'), '# ---\nFOO=bar\n');

    mockExecSyncVarlock.mockReturnValue({
      stdout: JSON.stringify({
        basePath: tmpDir,
        sources: [],
        settings: {},
        config: {
          FOO: { value: 'bar', isSensitive: false },
        },
      }),
      stderr: '',
    });

    mockWatchFile.mockImplementation(() => ({} as any));
    mockUnwatchFile.mockImplementation(() => undefined);
  });

  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__VARLOCK_ENV;
    delete process.env[DISABLE_WATCH_ENV_KEY];
    delete process.env[WATCHER_OWNER_ENV_KEY];
  });

  it('tears down already-installed watchers when updateInitialEnv receives the disable flag', async () => {
    const { loadEnvConfig, updateInitialEnv } = await import('../src/next-env-compat');

    loadEnvConfig(tmpDir, true);

    // Dev load always installs at least the .env.schema watcher before/alongside load.
    expect(mockWatchFile.mock.calls.length).toBeGreaterThan(0);
    const watchedPaths = [...new Set(mockWatchFile.mock.calls.map((call) => call[0] as string))];
    expect(watchedPaths).toContain(path.join(tmpDir, '.env.schema'));
    expect(mockUnwatchFile).not.toHaveBeenCalled();

    // This is the real Next.js path: after next.config mutates process.env,
    // config.ts diffs env and calls updateInitialEnv(newEnv) on @next/env.
    updateInitialEnv({ [DISABLE_WATCH_ENV_KEY]: '1' });

    expect(process.env[DISABLE_WATCH_ENV_KEY]).toBe('1');
    expect(mockUnwatchFile.mock.calls.length).toBeGreaterThan(0);
    for (const watchedPath of watchedPaths) {
      expect(mockUnwatchFile).toHaveBeenCalledWith(watchedPath);
    }
  });

  it('does not install new watchers after disableWatch is set via updateInitialEnv', async () => {
    const { loadEnvConfig, updateInitialEnv } = await import('../src/next-env-compat');

    loadEnvConfig(tmpDir, true);
    expect(mockWatchFile.mock.calls.length).toBeGreaterThan(0);

    updateInitialEnv({ [DISABLE_WATCH_ENV_KEY]: '1' });
    mockWatchFile.mockClear();

    // Later loadEnvConfig still calls enableExtraFileWatchers; must not re-watch.
    loadEnvConfig(tmpDir, true);
    expect(mockWatchFile).not.toHaveBeenCalled();
  });
});
