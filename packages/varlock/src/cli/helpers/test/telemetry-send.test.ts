import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

vi.mock('exit-hook', () => ({
  asyncExitHook: vi.fn(),
  gracefulExit: vi.fn(),
}));
vi.mock('../telemetry-usage-context', () => ({
  getTelemetryUsageContextPayload: vi.fn(() => ({})),
  captureUsageContextFromEnvGraph: vi.fn(),
}));
vi.mock('../js-package-manager-utils', () => ({
  detectJsPackageManager: vi.fn(),
}));
vi.mock('../../../lib/user-config-dir', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getUserVarlockDir: () => path.join(os.tmpdir(), 'varlock-telemetry-send-test'),
  };
});

import os from 'node:os';
import path from 'node:path';
import { asyncExitHook } from 'exit-hook';
import { getTelemetryUsageContextPayload } from '../telemetry-usage-context';

const flushImmediate = async () => new Promise((resolve) => {
  setImmediate(resolve);
});

describe('telemetry send + exit hook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.mocked(asyncExitHook).mockClear();
    vi.mocked(getTelemetryUsageContextPayload).mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // make sure the host machine's settings don't leak into the tests:
    // point cwd at an empty temp path so the project-config walk finds nothing
    // (including the developer's real ~/.varlock), and clear the opt-out env vars
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'varlock-telemetry-send-cwd'));
    vi.stubEnv('DEBUG', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('VARLOCK_TELEMETRY_DISABLED', '');
    vi.stubEnv('PH_OPT_OUT', '');
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('awaits a request fired after the exit sequence has already started', async () => {
    let resolveFetch!: (value: any) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const telemetry = await import('../telemetry');

    // the hook must be registered at module load, so it is already in exit-hook's
    // snapshot when a command calls gracefulExit() before trackCommand fires
    expect(asyncExitHook).toHaveBeenCalledTimes(1);
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    // simulate exit-hook invoking the callback before any telemetry was sent
    let hookSettled = false;
    const hookPromise = Promise.resolve(hookFn(0)).then(() => {
      hookSettled = true;
    });

    // telemetry fires late (e.g. from the command wrapper's `finally`)
    await telemetry.trackCommand('test-command');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // the hook must still be waiting on the in-flight request
    await flushImmediate();
    await flushImmediate();
    expect(hookSettled).toBe(false);

    resolveFetch({ ok: true, text: async () => 'ok' });
    await hookPromise;
    expect(hookSettled).toBe(true);
  });

  it('waits for every in-flight request, not just the last one', async () => {
    const resolvers: Array<(value: any) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    await telemetry.trackCommand('first');
    await telemetry.trackCommand('second');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    let hookSettled = false;
    const hookPromise = Promise.resolve(hookFn(0)).then(() => {
      hookSettled = true;
    });

    // resolving only one of the two requests must not release the hook
    resolvers[0]({ ok: true, text: async () => 'ok' });
    await flushImmediate();
    await flushImmediate();
    expect(hookSettled).toBe(false);

    resolvers[1]({ ok: true, text: async () => 'ok' });
    await hookPromise;
    expect(hookSettled).toBe(true);
  });

  it('when opted out, bails before building the payload and registers no exit hook', async () => {
    vi.stubEnv('VARLOCK_TELEMETRY_DISABLED', '1');

    const telemetry = await import('../telemetry');
    expect(asyncExitHook).not.toHaveBeenCalled();

    await telemetry.trackCommand('test-command');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTelemetryUsageContextPayload).not.toHaveBeenCalled();
  });
});
