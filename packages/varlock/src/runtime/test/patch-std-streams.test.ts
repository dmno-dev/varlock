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
  written: Array<string | Uint8Array>,
  write: (...args: Array<any>) => boolean,
};

/** stands in for process.stdout / process.stderr, recording what reaches the real stream */
function createFakeStream(isTTY = false): FakeStream {
  const stream: FakeStream = {
    isTTY,
    written: [],
    write(chunk: string | Uint8Array, encodingOrCallback?: any, maybeCallback?: any) {
      stream.written.push(chunk);
      const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
      callback?.();
      return true;
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

  it('calls the write callback, also when the whole chunk is held back', async () => {
    patchGlobalStdStreams();
    const onWritten = vi.fn();
    const onHeldBack = vi.fn();
    process.stdout.write('plain\n', onWritten);
    process.stdout.write('super-secr', 'utf8', onHeldBack);
    expect(onWritten).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(onHeldBack).toHaveBeenCalledTimes(1);
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
