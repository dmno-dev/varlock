import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { drainChildOutput, trackChildOutput } from '../drain-child-output';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('drainChildOutput', () => {
  it('waits for the actual redacted write callback after the pipe closes', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((_text: any, callback: any) => {
      completeWrite = callback;
      return false;
    });
    const stream = new PassThrough();
    const writer = trackChildOutput(stream, process.stdout);
    writer.write('pending redacted output');
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    let drained = false;
    const draining = drainChildOutput({ stdout: stream }).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(drained).toBe(false);
    completeWrite!();
    await draining;
    expect(drained).toBe(true);
  });

  it.each(['EPIPE', 'EIO'])('keeps the existing stderr error policy for %s', async (code) => {
    const error = Object.assign(new Error('destination write failed'), { code });
    vi.spyOn(process.stderr, 'write').mockImplementation((_text: any, callback: any) => {
      callback(error);
      return false;
    });
    const stream = new PassThrough();
    trackChildOutput(stream, process.stderr).write('redacted stderr');
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    const draining = drainChildOutput({ stderr: stream }, { exitCode: 7 });
    if (code === 'EPIPE') await expect(draining).resolves.toBeUndefined();
    else await expect(draining).rejects.toBe(error);
  });

  it('bounds parent writes even after the child pipes close', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => false);
    const stream = new PassThrough();
    trackChildOutput(stream, process.stdout).write('pending redacted output');
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    const rejection = expect(drainChildOutput({ stdout: stream })).rejects.toThrow('within 2000ms');
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
  });

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
