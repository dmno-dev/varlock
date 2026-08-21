import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

vi.mock('exit-hook', () => ({
  asyncExitHook: vi.fn(),
  gracefulExit: vi.fn(),
}));
vi.mock('../telemetry-usage-context', () => ({
  getIntegrationPayload: vi.fn(() => ({})),
  takePendingSchemaEventPayload: vi.fn(() => null),
  setSchemaEventSupersededHandler: vi.fn(),
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
import { getIntegrationPayload, takePendingSchemaEventPayload } from '../telemetry-usage-context';

const flushImmediate = async () => new Promise((resolve) => {
  setImmediate(resolve);
});

/** The parsed PostHog payload from the nth fetch call */
const sentPayload = (fetchMock: ReturnType<typeof vi.fn>, index: number) => {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
};

describe('telemetry send + exit hook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.mocked(asyncExitHook).mockClear();
    vi.mocked(getIntegrationPayload).mockClear();
    vi.mocked(takePendingSchemaEventPayload).mockClear();
    vi.mocked(takePendingSchemaEventPayload).mockReturnValue(null);
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

  it('registers the exit hook at module load and awaits an in-flight request', async () => {
    let resolveFetch!: (value: any) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const telemetry = await import('../telemetry');

    // the hook must be registered at module load: exit-hook snapshots its callbacks when
    // the exit starts, so one registered mid-capture would never be awaited
    expect(asyncExitHook).toHaveBeenCalledTimes(1);
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    await telemetry.trackCommand('test-command');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let hookSettled = false;
    const hookPromise = Promise.resolve(hookFn(0)).then(() => {
      hookSettled = true;
    });

    await flushImmediate();
    await flushImmediate();
    expect(hookSettled).toBe(false);

    resolveFetch({ ok: true, text: async () => 'ok' });
    await hookPromise;
    expect(hookSettled).toBe(true);
  });

  it('sends the pending schema event from the exit hook and waits for it', async () => {
    let resolveFetch!: (value: any) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.mocked(takePendingSchemaEventPayload).mockReturnValueOnce({ graph_loaded: true, error_code: 'validation_error' });

    await import('../telemetry');
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    // nothing sent until the exit sequence starts
    expect(fetchMock).not.toHaveBeenCalled();

    let hookSettled = false;
    const hookPromise = Promise.resolve(hookFn(0)).then(() => {
      hookSettled = true;
    });
    await flushImmediate();

    // the hook originates the event itself, so there is no race with the pending-set snapshot
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = sentPayload(fetchMock, 0);
    expect(payload.event).toBe('cli_schema_loaded');
    expect(payload.properties.error_code).toBe('validation_error');

    await flushImmediate();
    expect(hookSettled).toBe(false);

    resolveFetch({ ok: true, text: async () => 'ok' });
    await hookPromise;
    expect(hookSettled).toBe(true);
  });

  it('sends no schema event when the run never loaded a graph', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => 'ok' });

    await import('../telemetry');
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    await hookFn(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tags both events with the same invocation_id', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => 'ok' });
    vi.mocked(takePendingSchemaEventPayload).mockReturnValueOnce({ graph_loaded: true });

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(asyncExitHook).mock.calls[0][0];

    await telemetry.trackCommand('proxy run');
    await hookFn(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const command = sentPayload(fetchMock, 0);
    const schema = sentPayload(fetchMock, 1);
    expect(command.event).toBe('cli_command_executed');
    expect(command.properties.command).toBe('proxy run');
    expect(schema.event).toBe('cli_schema_loaded');
    // the join key between the two halves of one run
    expect(command.properties.invocation_id).toBeTruthy();
    expect(schema.properties.invocation_id).toBe(command.properties.invocation_id);
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
    await telemetry.flushSchemaLoadedEvent();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getIntegrationPayload).not.toHaveBeenCalled();
    expect(takePendingSchemaEventPayload).not.toHaveBeenCalled();
  });
});
