import {
  describe, test, expect, afterEach, vi,
} from 'vitest';
import { gracefulExit } from 'exit-hook';
import { claimSignals, createChildSignalForwarder, FORWARDED_SIGNALS } from '../child-signals';

vi.mock('exit-hook', () => ({ gracefulExit: vi.fn() }));

const SIGNALS: Array<NodeJS.Signals> = ['SIGTERM', 'SIGINT'];

describe('claimSignals', () => {
  afterEach(() => {
    for (const signal of [...SIGNALS, ...FORWARDED_SIGNALS]) process.removeAllListeners(signal);
  });

  test('removes every listener except the one to keep', () => {
    const foreign = () => undefined;
    const ours = () => undefined;
    for (const signal of SIGNALS) {
      process.on(signal, foreign);
      process.on(signal, ours);
    }

    claimSignals(SIGNALS, ours);

    for (const signal of SIGNALS) {
      expect(process.listeners(signal)).toEqual([ours]);
    }
  });

  test('a signal received before attach() is forwarded once the child is attached', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = { pid: 424242, kill: vi.fn((_signal?: number | NodeJS.Signals) => true) };
    try {
      const forwarder = createChildSignalForwarder();
      // signal lands while the caller is still between spawn and attach
      process.emit('SIGTERM', 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();

      forwarder.attach(child);
      // forwarded to the process group (no terminal under the test runner) or the pid
      const forwarded = forwarder.useProcessGroup
        ? killSpy.mock.calls.some(([pid, sig]) => pid === -child.pid && sig === 'SIGTERM')
        : child.kill.mock.calls.some(([sig]) => sig === 'SIGTERM');
      expect(forwarded).toBe(true);

      // attach is idempotent and the buffer is drained: no second delivery
      const callsBefore = killSpy.mock.calls.length + child.kill.mock.calls.length;
      forwarder.attach(child);
      expect(killSpy.mock.calls.length + child.kill.mock.calls.length).toBe(callsBefore);
      forwarder.detach();
    } finally {
      killSpy.mockRestore();
    }
  });

  test('a signal after detach() exits varlock with 128+N instead of being swallowed', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = { pid: 424242, kill: vi.fn((_signal?: number | NodeJS.Signals) => true) };
    try {
      const forwarder = createChildSignalForwarder();
      forwarder.attach(child);
      forwarder.detach();
      // e.g. while flushing output to a stalled reader after the child exited
      process.emit('SIGTERM', 'SIGTERM');
      expect(gracefulExit).toHaveBeenCalledWith(143);
      expect(child.kill).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  test('createChildSignalForwarder leaves exactly one listener per forwarded signal', () => {
    // mimic exit-hook, which registers its own SIGINT/SIGTERM listeners at module load
    const exitHookLike = () => undefined;
    for (const signal of SIGNALS) process.once(signal, exitHookLike);

    createChildSignalForwarder();

    for (const signal of SIGNALS) {
      const listeners = process.listeners(signal);
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).not.toBe(exitHookLike);
    }
  });
});
