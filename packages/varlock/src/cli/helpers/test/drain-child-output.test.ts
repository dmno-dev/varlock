import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { drainChildOutput } from '../drain-child-output';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('drainChildOutput', () => {
  it.each([{ exitCode: 7 }, { exitCode: 0, shutdownRequested: true }])('keeps an existing failure or forwarded shutdown status on timeout: %j', async (completion) => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = new PassThrough();
    const draining = drainChildOutput({ stdout: stream }, completion);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(draining).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('Output may be incomplete'));
    expect(stream.destroyed).toBe(true);
  });

  it('does not wait for inherited terminal streams', async () => {
    await expect(drainChildOutput({})).resolves.toBeUndefined();
  });

  it('accepts pipes that closed before the child exited', async () => {
    const stream = new PassThrough();
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    await expect(drainChildOutput({ stdout: stream })).resolves.toBeUndefined();
  });

  it('waits until both captured streams close', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let drained = false;
    const draining = drainChildOutput({ stdout, stderr }).then(() => {
      drained = true;
    });
    const closed = once(stdout, 'close');
    stdout.destroy();
    await closed;
    expect(drained).toBe(false);
    stderr.destroy();
    await draining;
    expect(drained).toBe(true);
  });

  it('closes pipe readers and rejects rather than hanging past two seconds', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const rejection = expect(drainChildOutput({ stdout: stream }))
      .rejects.toThrow('Child output did not finish draining within 2000ms');
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount('close')).toBe(0);
  });
});
