import {
  afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';
import { execSyncVarlock, VarlockExecError } from '../exec-sync-varlock';

vi.mock('../exec-sync-varlock', async (importOriginal) => ({
  ...await importOriginal<typeof import('../exec-sync-varlock')>(),
  execSyncVarlock: vi.fn(),
}));
vi.mock('../injected-env-reuse', () => ({ evaluateInjectedEnvReuse: () => ({ reuse: false }) }));
vi.mock('../../runtime/env', () => ({ getPreInjectionProcessEnv: () => ({}), initVarlockEnv: vi.fn() }));
vi.mock('../../runtime/patch-console', () => ({ patchGlobalConsole: vi.fn() }));
vi.mock('../../runtime/patch-process-streams', () => ({ patchProcessStreams: vi.fn() }));
vi.mock('../../runtime/patch-server-response', () => ({ patchGlobalServerResponse: vi.fn() }));
vi.mock('../../runtime/patch-response', () => ({ patchGlobalResponse: vi.fn() }));
vi.mock('../cli-child-marker', () => ({ isVarlockCliChild: () => false }));

describe('auto-load CLI failure handling', () => {
  const exitSentinel = new Error('host exited');
  let stderr: MockInstance<typeof process.stderr.write>;
  let exit: ReturnType<typeof vi.spyOn>;
  let error: VarlockExecError;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('_VARLOCK_THROW_ON_LOAD_ERROR', '');
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw exitSentinel;
    });
    error = new VarlockExecError(
      'varlock CLI crashed (exit code 0xC0000409). Command: varlock load',
      '{"config":{"SECRET":{"value":"do-not-print"}}}',
      '',
      -1073740791,
    );
    vi.mocked(execSyncVarlock).mockImplementation(() => {
      throw error;
    });
  });

  afterEach(() => {
    delete (globalThis as any)._varlockOnLoadError;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each(['', 'native assertion'])('reports a crash with stderr=%j and exits 1 without printing secrets', async (childStderr) => {
    error.stderr = childStderr;
    await expect(import('../../auto-load')).rejects.toBe(exitSentinel);
    expect(exit).toHaveBeenCalledWith(1);
    const output = stderr.mock.calls.map(([text]) => text).join('');
    expect(output).toContain(error.message);
    if (childStderr) expect(output).toContain(`${childStderr}\n`);
    expect(output).not.toContain('do-not-print');
  });

  it('preserves ordinary CLI exit codes and validation diagnostics', async () => {
    error.exitCode = 2;
    error.stderr = 'invalid configuration\n';
    await expect(import('../../auto-load')).rejects.toBe(exitSentinel);
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(error.stderr);
  });

  it('gives a sync hook the original crash status and partial values, then exits 1', async () => {
    const hook = vi.fn();
    (globalThis as any)._varlockOnLoadError = hook;
    await expect(import('../../auto-load')).rejects.toBe(exitSentinel);
    expect(hook).toHaveBeenCalledWith(error, { SECRET: 'do-not-print' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uses exit 1 for the async hook timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'listenerCount').mockReturnValue(1);
    (globalThis as any)._varlockOnLoadError = () => new Promise(() => {
      // Never settles, so auto-load must enforce its reporting deadline.
    });
    await expect(import('../../auto-load')).rejects.toBe(error);
    expect(() => vi.advanceTimersByTime(2000)).toThrow(exitSentinel);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('throws the original error in throw mode but bounds the host exit with code 1', async () => {
    vi.useFakeTimers();
    vi.stubEnv('_VARLOCK_THROW_ON_LOAD_ERROR', '1');
    await expect(import('../../auto-load')).rejects.toBe(error);
    expect(() => vi.advanceTimersByTime(2000)).toThrow(exitSentinel);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
