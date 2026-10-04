import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { resetRedactionMap, varlockSettings } from '../env';
import { patchGlobalStdStreams, unpatchGlobalStdStreams } from '../patch-std-streams';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET_VALUE = 'super-secret-value-12345';
const REDACTED_SECRET = 'su▒▒▒▒▒';

type FakeStream = {
  isTTY: boolean,
  writableNeedDrain: boolean,
  writeResult: boolean,
  writeError: Error | undefined,
  written: Array<string | Uint8Array>,
  write: (...args: Array<any>) => boolean,
};

/** stands in for process.stdout / process.stderr */
function createFakeStream(isTTY = false): FakeStream {
  const stream: FakeStream = {
    isTTY,
    writableNeedDrain: false,
    writeResult: true,
    writeError: undefined,
    written: [],
    write(chunk: string | Uint8Array, encodingOrCallback?: any, maybeCallback?: any) {
      stream.written.push(chunk);
      const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
      callback?.(stream.writeError);
      if (!stream.writeResult) stream.writableNeedDrain = true;
      return stream.writeResult;
    },
  };
  return stream;
}

/**
 * @see https://github.com/dmno-dev/varlock/issues/1149
 */
describe('patchGlobalStdStreams', () => {
  let stdout: FakeStream;
  let stderr: FakeStream;

  function useStreams(opts?: { stdoutIsTTY?: boolean, stderrIsTTY?: boolean }) {
    stdout = createFakeStream(opts?.stdoutIsTTY);
    stderr = createFakeStream(opts?.stderrIsTTY);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as any);
    vi.spyOn(process, 'stderr', 'get').mockReturnValue(stderr as any);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetRedactionMap({
      config: { API_KEY: { isSensitive: true, value: SECRET_VALUE } },
    } as unknown as SerializedEnvGraph);
    useStreams();
  });

  afterEach(() => {
    unpatchGlobalStdStreams();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete varlockSettings.redactLogs;
  });

  it('redacts a secret written to stdout and stderr', () => {
    patchGlobalStdStreams();
    process.stdout.write(`out: ${SECRET_VALUE}\n`);
    process.stderr.write(`err: ${SECRET_VALUE}\n`);
    expect(stdout.written.join('')).toBe(`out: ${REDACTED_SECRET}\n`);
    expect(stderr.written.join('')).toBe(`err: ${REDACTED_SECRET}\n`);
  });

  it('redacts a secret split across two writes', () => {
    patchGlobalStdStreams();
    process.stdout.write(`key=${SECRET_VALUE.slice(0, 10)}`);
    process.stdout.write(`${SECRET_VALUE.slice(10)}\n`);
    expect(stdout.written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
  });

  it('flushes held-back output after the timeout', () => {
    patchGlobalStdStreams();
    process.stdout.write('key=super-secr');
    expect(stdout.written.join('')).toBe('key=');
    vi.runAllTimers();
    expect(stdout.written.join('')).toBe('key=super-secr');
  });

  // calling the new listeners directly: emitting a real event would run the test runner's too
  it.each(['beforeExit', 'exit'] as const)('flushes held-back output on %s', (eventName) => {
    const listenersBefore = process.listeners(eventName as 'exit');
    patchGlobalStdStreams();
    const addedListeners = process.listeners(eventName as 'exit').filter((l) => !listenersBefore.includes(l));
    expect(addedListeners).toHaveLength(2); // one per stream
    process.stdout.write('key=super-secr');
    for (const listener of addedListeners) listener(0);
    expect(stdout.written.join('')).toBe('key=super-secr');
  });

  it('removes its exit listeners when unpatched', () => {
    const exitListeners = process.listenerCount('exit');
    const beforeExitListeners = process.listenerCount('beforeExit');
    patchGlobalStdStreams();
    unpatchGlobalStdStreams();
    expect(process.listenerCount('exit')).toBe(exitListeners);
    expect(process.listenerCount('beforeExit')).toBe(beforeExitListeners);
  });

  it('calls the write callback once the chunk is written', () => {
    patchGlobalStdStreams();
    const callback = vi.fn();
    process.stdout.write('plain\n', callback);
    process.stdout.write('more\n', 'utf8', callback);
    process.stdout.write('', callback);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('does not call the write callback before held-back text is written', async () => {
    patchGlobalStdStreams();
    const callback = vi.fn();
    process.stdout.write('super-secr', callback);
    await Promise.resolve();
    expect(stdout.written).toEqual([]);
    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(stdout.written.join('')).toBe('super-secr');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('holds the callback of a partly held chunk until its tail is written', () => {
    patchGlobalStdStreams();
    const first = vi.fn();
    const second = vi.fn();
    process.stdout.write(`key=${SECRET_VALUE.slice(0, 10)}`, first);
    expect(stdout.written.join('')).toBe('key=');
    expect(first).not.toHaveBeenCalled();
    process.stdout.write(`${SECRET_VALUE.slice(10)}\n`, second);
    expect(stdout.written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('passes the error of a delayed write to the callback', () => {
    patchGlobalStdStreams();
    const callback = vi.fn();
    process.stdout.write('super-secr', callback);
    stdout.writeError = new Error('EPIPE');
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledWith(stdout.writeError);
  });

  it('passes the error of an earlier part of the chunk to the callback', () => {
    patchGlobalStdStreams();
    const callback = vi.fn();
    const error = new Error('EPIPE');
    stdout.writeError = error;
    process.stdout.write('key=super-secr', callback);
    stdout.writeError = undefined;
    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledWith(error);
  });

  it('returns what the underlying write returns', () => {
    patchGlobalStdStreams();
    expect(process.stdout.write('plain\n')).toBe(true);
    stdout.writeResult = false;
    expect(process.stdout.write('plain\n')).toBe(false);
  });

  it('reports backpressure when the whole chunk is held back', () => {
    patchGlobalStdStreams();
    expect(process.stdout.write('super-secr')).toBe(true);
    stdout.writableNeedDrain = true;
    expect(process.stdout.write('et-val')).toBe(false);
  });

  it('reports backpressure from a delayed flush on the next write', () => {
    patchGlobalStdStreams();
    expect(process.stdout.write('super-secr')).toBe(true);
    stdout.writeResult = false;
    vi.runAllTimers();
    expect(process.stdout.write('su')).toBe(false);
  });

  it('redacts a secret inside a byte chunk', () => {
    patchGlobalStdStreams();
    process.stdout.write(Buffer.from(`key=${SECRET_VALUE}\n`));
    expect(stdout.written).toEqual([`key=${REDACTED_SECRET}\n`]);
  });

  it('passes byte chunks without a secret through untouched', () => {
    patchGlobalStdStreams();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    process.stdout.write(bytes);
    expect(stdout.written).toEqual([bytes]);
  });

  it('writes held-back text before a byte chunk', () => {
    patchGlobalStdStreams();
    const bytes = Buffer.from('bytes');
    process.stdout.write('super-secr');
    process.stdout.write(bytes);
    expect(stdout.written).toEqual(['super-secr', bytes]);
  });

  it('passes strings in another encoding through untouched', () => {
    patchGlobalStdStreams();
    const hex = Buffer.from(SECRET_VALUE).toString('hex');
    process.stdout.write(hex, 'hex');
    expect(stdout.written).toEqual([hex]);
  });

  it('leaves a stream attached to a terminal alone', () => {
    useStreams({ stdoutIsTTY: true });
    patchGlobalStdStreams();
    process.stdout.write(`out: ${SECRET_VALUE}\n`);
    process.stderr.write(`err: ${SECRET_VALUE}\n`);
    expect(stdout.written.join('')).toBe(`out: ${SECRET_VALUE}\n`);
    expect(stderr.written.join('')).toBe(`err: ${REDACTED_SECRET}\n`);
  });

  it('does not wrap a stream twice', () => {
    patchGlobalStdStreams();
    const patchedWrite = process.stdout.write;
    patchGlobalStdStreams();
    expect(process.stdout.write).toBe(patchedWrite);
  });

  it('is disabled by @redactLogs=false', () => {
    varlockSettings.redactLogs = false;
    patchGlobalStdStreams();
    process.stdout.write(`out: ${SECRET_VALUE}\n`);
    expect(stdout.written.join('')).toBe(`out: ${SECRET_VALUE}\n`);
  });

  it('is disabled by _VARLOCK_REDACT_STDOUT=false', () => {
    vi.stubEnv('_VARLOCK_REDACT_STDOUT', 'false');
    patchGlobalStdStreams();
    process.stdout.write(`out: ${SECRET_VALUE}\n`);
    expect(stdout.written.join('')).toBe(`out: ${SECRET_VALUE}\n`);
  });

  it('_VARLOCK_REDACT_STDOUT=true overrides @redactLogs=false', () => {
    varlockSettings.redactLogs = false;
    vi.stubEnv('_VARLOCK_REDACT_STDOUT', 'true');
    patchGlobalStdStreams();
    process.stdout.write(`out: ${SECRET_VALUE}\n`);
    expect(stdout.written.join('')).toBe(`out: ${REDACTED_SECRET}\n`);
  });

  it('unpatchGlobalStdStreams restores the original write', () => {
    const originalWrite = stdout.write;
    patchGlobalStdStreams();
    unpatchGlobalStdStreams();
    expect(process.stdout.write).toBe(originalWrite);
  });
});
