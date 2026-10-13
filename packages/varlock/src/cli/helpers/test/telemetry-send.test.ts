import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

vi.mock('exit-hook', () => ({
  default: vi.fn(),
  asyncExitHook: vi.fn(),
  gracefulExit: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
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
import exitHook from 'exit-hook';
import { spawn } from 'node:child_process';
import { getIntegrationPayload, takePendingSchemaEventPayload } from '../telemetry-usage-context';

const flushImmediate = async () => new Promise((resolve) => {
  setImmediate(resolve);
});

/** The parsed PostHog payload from the nth fetch call */
const sentPayload = (fetchMock: ReturnType<typeof vi.fn>, index: number) => {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
};

/** The events handed to the nth spawned sender, parsed from its env */
const handedOffEvents = (index: number) => {
  const opts = vi.mocked(spawn).mock.calls[index][2] as any;
  return JSON.parse(opts.env.__VARLOCK_TELEMETRY_EVENTS);
};

const okResponse = { ok: true, text: async () => 'ok' };

describe('telemetry send + exit handoff', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let fakeChild: { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>; pid: number };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(exitHook).mockClear();
    vi.mocked(spawn).mockClear();
    fakeChild = { on: vi.fn(), unref: vi.fn(), pid: 4242 };
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
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
    vi.stubEnv('__VARLOCK_TELEMETRY_EVENTS', '');
  });
  afterEach(() => {
    vi.useRealTimers();
    cwdSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('registers a synchronous exit hook at module load', async () => {
    await import('../telemetry');
    // exit-hook snapshots its callbacks when the exit starts, so one registered mid-capture
    // would never run. Synchronous so it also runs on a plain process.exit()
    expect(exitHook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exitHook).mock.calls[0][0]).toBeTypeOf('function');
  });

  it('does not touch the network before the in-process send delay', async () => {
    fetchMock.mockResolvedValue(okResponse);

    const telemetry = await import('../telemetry');
    await telemetry.trackCommand('load');
    await flushImmediate();

    // a short command exits before any request could complete, so starting one would only
    // cost main-thread time (the lazy HTTP client init) for nothing
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts the request in the background and hands it off at exit if still in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => { /* never settles */ }));

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('load');
    vi.advanceTimersByTime(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inProcess = sentPayload(fetchMock, 0);
    expect(inProcess.event).toBe('cli_command_executed');
    expect(inProcess.uuid).toBeTruthy();
    expect(inProcess.timestamp).toBeTruthy();

    // the hook returns without waiting on the network
    hookFn(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = vi.mocked(spawn).mock.calls[0] as any;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([process.argv[1], '--flush-telemetry']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    // the sender never records telemetry of its own
    expect(opts.env.VARLOCK_TELEMETRY_DISABLED).toBe('1');
    // and a bunfig-preloaded auto-load inside it must bail instead of spawning a load CLI:
    // the CLI cleared this marker from its own env at startup, so the handoff restores it
    expect(process.env.__VARLOCK_CLI_CHILD).toBeUndefined();
    expect(opts.env.__VARLOCK_CLI_CHILD).toBe('1');
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(fakeChild.on).toHaveBeenCalledWith('error', expect.any(Function));

    // the sender gets the exact same event (same uuid) so a duplicate can be collapsed
    const events = handedOffEvents(0);
    expect(events).toHaveLength(1);
    expect(events[0].uuid).toBe(inProcess.uuid);
    expect(events[0].properties.command).toBe('load');
  });

  it('spawns nothing at exit when every request already completed', async () => {
    fetchMock.mockResolvedValue(okResponse);

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('run');
    vi.advanceTimersByTime(200);
    await flushImmediate();
    await flushImmediate();

    hookFn(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not retry a request that failed outright', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('load');
    vi.advanceTimersByTime(200);
    await flushImmediate();
    await flushImmediate();

    hookFn(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('hands the pending schema event straight to the sender instead of fetching at exit', async () => {
    fetchMock.mockResolvedValue(okResponse);
    vi.mocked(takePendingSchemaEventPayload).mockReturnValueOnce({ graph_loaded: true, error_code: 'validation_error' });

    await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    // nothing sent until the exit sequence starts
    expect(fetchMock).not.toHaveBeenCalled();

    hookFn(0);

    // the process is exiting, so an in-process request could never finish
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const events = handedOffEvents(0);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('cli_schema_loaded');
    expect(events[0].properties.error_code).toBe('validation_error');
  });

  it('sends no schema event when the run never loaded a graph', async () => {
    fetchMock.mockResolvedValue(okResponse);

    await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    hookFn(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('hands off every unconfirmed event in one sender, tagged with the same invocation_id', async () => {
    fetchMock.mockReturnValue(new Promise(() => { /* never settles */ }));
    vi.mocked(takePendingSchemaEventPayload).mockReturnValueOnce({ graph_loaded: true });

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('proxy run');
    hookFn(0);

    expect(spawn).toHaveBeenCalledTimes(1);
    const events = handedOffEvents(0);
    expect(events.map((e: any) => e.event)).toEqual(['cli_command_executed', 'cli_schema_loaded']);
    expect(events[0].properties.command).toBe('proxy run');
    // the join key between the two halves of one run
    expect(events[0].properties.invocation_id).toBeTruthy();
    expect(events[1].properties.invocation_id).toBe(events[0].properties.invocation_id);
    expect(events[0].uuid).not.toBe(events[1].uuid);
  });

  it('hands off only once, and a handed-off event is never also sent in-process', async () => {
    fetchMock.mockResolvedValue(okResponse);

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('load');
    hookFn(0);
    hookFn(0);
    expect(spawn).toHaveBeenCalledTimes(1);

    // the exit is under way; if the process somehow lingers past the delay, the request
    // must not start for an event the sender already owns
    vi.advanceTimersByTime(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invokes the standalone binary directly, without a script argument', async () => {
    fetchMock.mockReturnValue(new Promise(() => { /* never settles */ }));
    vi.stubGlobal('Bun', { isStandaloneExecutable: true });

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('load');
    hookFn(0);

    const [command, args] = vi.mocked(spawn).mock.calls[0] as any;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['--flush-telemetry']);
  });

  it('survives a spawn failure', async () => {
    fetchMock.mockReturnValue(new Promise(() => { /* never settles */ }));
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('EAGAIN');
    });

    const telemetry = await import('../telemetry');
    const hookFn = vi.mocked(exitHook).mock.calls[0][0];

    await telemetry.trackCommand('load');
    expect(() => hookFn(0)).not.toThrow();
  });

  describe('sender process', () => {
    const events = [
      { event: 'cli_command_executed', uuid: 'a', properties: { command: 'load' } },
      { event: 'cli_schema_loaded', uuid: 'b', properties: { graph_loaded: true } },
    ];

    it('posts the handed-off events in a single request and spawns nothing itself', async () => {
      fetchMock.mockResolvedValue(okResponse);
      vi.stubEnv('__VARLOCK_TELEMETRY_EVENTS', JSON.stringify(events));
      // the parent sets this on the sender; it must not stop delivery
      vi.stubEnv('VARLOCK_TELEMETRY_DISABLED', '1');

      const telemetry = await import('../telemetry');
      await telemetry.runTelemetrySender();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/i\/v0\/e\/$/);
      expect(JSON.parse(init.body)).toEqual(events);
      // bounded, so a sender never lingers on a dead network
      expect(init.signal).toBeInstanceOf(AbortSignal);

      // opted out (by the parent) means no exit hook, so the sender can never spawn a sender
      expect(exitHook).not.toHaveBeenCalled();
      telemetry.handOffUnconfirmedEvents();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('is a no-op without a payload and swallows delivery failures', async () => {
      const telemetry = await import('../telemetry');
      await telemetry.runTelemetrySender();
      expect(fetchMock).not.toHaveBeenCalled();

      vi.stubEnv('__VARLOCK_TELEMETRY_EVENTS', JSON.stringify([{ event: 'cli_command_executed' }]));
      fetchMock.mockRejectedValue(new Error('timeout'));
      await expect(telemetry.runTelemetrySender()).resolves.toBeUndefined();
    });
  });

  it('when opted out, bails before building the payload and registers no exit hook', async () => {
    vi.stubEnv('VARLOCK_TELEMETRY_DISABLED', '1');

    const telemetry = await import('../telemetry');
    expect(exitHook).not.toHaveBeenCalled();

    await telemetry.trackCommand('test-command');
    await telemetry.flushSchemaLoadedEvent();
    telemetry.handOffUnconfirmedEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(getIntegrationPayload).not.toHaveBeenCalled();
    expect(takePendingSchemaEventPayload).not.toHaveBeenCalled();
  });
});
