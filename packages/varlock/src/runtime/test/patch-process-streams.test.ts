import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  resetRedactionMap, varlockSettings, redactSensitiveConfig, redactAllSensitiveValues,
} from '../env';
import {
  patchStreamWrite, unpatchStreamWrite, flushStreamWrite, shouldRedactProcessStream,
} from '../patch-process-streams';
import { Writable } from 'node:stream';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET = 'super-secret-value-12345';
const REDACTED = 'su▒▒▒▒▒';

function setSecrets(config: Record<string, { value: string, redactLogs?: boolean }>) {
  resetRedactionMap({
    config: Object.fromEntries(
      Object.entries(config).map(([key, item]) => [key, { isSensitive: true, ...item }]),
    ),
  } as unknown as SerializedEnvGraph);
}

/** a fake stream recording what reaches the underlying write */
function createFakeStream() {
  const writes: Array<string | Uint8Array> = [];
  const stream = {
    isTTY: false,
    write(chunk: string | Uint8Array, encodingOrCb?: any, maybeCb?: any) {
      writes.push(chunk);
      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      if (cb) queueMicrotask(() => cb());
      return true;
    },
  };
  const output = () => writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w).toString('latin1'))).join('');
  return { stream, writes, output };
}

describe('patchStreamWrite', () => {
  let fake: ReturnType<typeof createFakeStream>;

  beforeEach(() => {
    vi.useFakeTimers();
    setSecrets({ API_KEY: { value: SECRET } });
    fake = createFakeStream();
    patchStreamWrite(fake.stream);
  });

  afterEach(() => {
    unpatchStreamWrite(fake.stream);
    vi.useRealTimers();
  });

  it('redacts strings', () => {
    fake.stream.write(`key=${SECRET}\n`);
    expect(fake.output()).toBe(`key=${REDACTED}\n`);
  });

  it('redacts utf8 buffers', () => {
    fake.stream.write(Buffer.from(`key=${SECRET}\n`));
    expect(fake.output()).toBe(`key=${REDACTED}\n`);
  });

  it('redacts a secret split across writes', () => {
    fake.stream.write('key=super-sec');
    fake.stream.write('ret-value-12345\n');
    expect(fake.output()).toBe(`key=${REDACTED}\n`);
  });

  it('flushes held-back text after a timeout', () => {
    fake.stream.write('ends with super-sec');
    expect(fake.output()).toBe('ends with ');
    vi.advanceTimersByTime(200);
    expect(fake.output()).toBe('ends with super-sec');
  });

  it('flushes held-back text on demand (e.g. on exit)', () => {
    fake.stream.write('ends with super-sec');
    flushStreamWrite(fake.stream);
    expect(fake.output()).toBe('ends with super-sec');
  });

  it('passes binary buffers through untouched, keeping order', () => {
    const binary = Uint8Array.from([0xFF, 0xFE, 0x00, 0x80]);
    fake.stream.write('text super-sec');
    fake.stream.write(binary);
    expect(fake.writes.at(-1)).toBe(binary);
    expect(fake.output().startsWith('text super-sec')).toBe(true);
  });

  it('passes non-utf8 string encodings through untouched', () => {
    const encoded = Buffer.from(SECRET).toString('base64');
    fake.stream.write(encoded, 'base64');
    expect(fake.writes).toEqual([encoded]);
  });

  it('keeps a multi-byte character split across buffers intact', () => {
    const bytes = Buffer.from(`é ${SECRET}\n`);
    fake.stream.write(bytes.subarray(0, 1)); // first byte of `é`
    fake.stream.write(bytes.subarray(1));
    expect(fake.output()).toBe(`é ${REDACTED}\n`);
  });

  it('fires a callback once the writable part is out, without waiting on held-back text', async () => {
    // writers that wait on each callback before writing more must not force the held prefix
    // out (unredacted) before the rest of the value arrives
    const cb = vi.fn();
    fake.stream.write('ends with super-sec', cb);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(fake.output()).toBe('ends with ');
    fake.stream.write('ret-value-12345\n');
    expect(fake.output()).toBe(`ends with ${REDACTED}\n`);
  });

  it('fires the callback of a write that is entirely held back', async () => {
    const cb = vi.fn();
    fake.stream.write('super-sec', cb);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(fake.output()).toBe('');
  });

  it('supports the (chunk, encoding, cb) signature', async () => {
    const cb = vi.fn();
    fake.stream.write(`${SECRET}\n`, 'utf8', cb);
    await vi.runAllTimersAsync();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(fake.output()).toBe(`${REDACTED}\n`);
  });

  it('skips items marked @sensitive={redactLogs=false}', () => {
    setSecrets({ API_KEY: { value: SECRET }, PRINTED_TOKEN: { value: 'printed-token-abcdef', redactLogs: false } });
    fake.stream.write(`${SECRET} printed-token-abcdef\n`);
    expect(fake.output()).toBe(`${REDACTED} printed-token-abcdef\n`);
  });

  it('prints values revealed with revealSensitiveConfig (strips the markers)', () => {
    fake.stream.write(`revealed: 👁 ${SECRET} 👁\n`);
    expect(fake.output()).toBe(`revealed: ${SECRET}\n`);
  });

  it('redactLogs=false values are skipped by redactSensitiveConfig but not by leak-prevention scrubbing', () => {
    setSecrets({ PRINTED_TOKEN: { value: 'printed-token-abcdef', redactLogs: false } });
    expect(redactSensitiveConfig('printed-token-abcdef')).toBe('printed-token-abcdef');
    expect(redactAllSensitiveValues('printed-token-abcdef')).toBe('pr▒▒▒▒▒');
  });

  it('keeps redacting a value shared with an item that is not exempt', () => {
    setSecrets({
      API_KEY: { value: SECRET },
      SAME_VALUE_PRINTED: { value: SECRET, redactLogs: false },
    });
    fake.stream.write(`${SECRET}\n`);
    expect(fake.output()).toBe(`${REDACTED}\n`);
  });

  it('prints a revealed value split across writes', () => {
    fake.stream.write('revealed: 👁 ');
    fake.stream.write(`${SECRET.slice(0, 8)}`);
    fake.stream.write(`${SECRET.slice(8)} 👁\n`);
    expect(fake.output()).toBe(`revealed: ${SECRET}\n`);
  });

  it('redacts a complete value whose ending is also the start of a value (self-overlap)', () => {
    // `secret-token-s` ends with `s`, which is the start of itself
    setSecrets({ SELF_OVERLAP: { value: 'secret-token-s' } });
    fake.stream.write('secret-token-s');
    flushStreamWrite(fake.stream);
    expect(fake.output()).toBe('se▒▒▒▒▒');
  });

  it('redacts a complete value whose ending is the start of another value', () => {
    setSecrets({ A: { value: 'token-aaaa-xy' }, B: { value: 'xy-other-value-1' } });
    fake.stream.write('token-aaaa-xy');
    flushStreamWrite(fake.stream);
    expect(fake.output()).toBe('to▒▒▒▒▒');
    // and the other value is still caught when it completes
    fake.writes.length = 0;
    fake.stream.write('x');
    fake.stream.write('y-other-value-1\n');
    expect(fake.output()).toBe('xy▒▒▒▒▒\n');
  });

  it('does not double-patch', () => {
    expect(patchStreamWrite(fake.stream)).toBe(false);
  });
});

describe('shouldRedactProcessStream', () => {
  const pipe = { isTTY: false, write: () => true };
  const tty = { isTTY: true, write: () => true };

  afterEach(() => {
    delete varlockSettings.redactStdout;
  });

  it('is off unless opted in', () => {
    expect(shouldRedactProcessStream('stdout', pipe, {})).toBe(false);
  });

  it('@redactLogs={stdout=true} redacts non-TTY streams only', () => {
    varlockSettings.redactStdout = true;
    expect(shouldRedactProcessStream('stdout', pipe, {})).toBe(true);
    expect(shouldRedactProcessStream('stdout', tty, {})).toBe(false);
  });

  it('_VARLOCK_REDACT_STDOUT forces it on or off', () => {
    expect(shouldRedactProcessStream('stdout', tty, { _VARLOCK_REDACT_STDOUT: '1' })).toBe(true);
    varlockSettings.redactStdout = true;
    expect(shouldRedactProcessStream('stdout', pipe, { _VARLOCK_REDACT_STDOUT: '0' })).toBe(false);
  });

  it('skips streams a parent `varlock run` is already redacting', () => {
    varlockSettings.redactStdout = true;
    const env = { __VARLOCK_REDACTED_STREAMS: '1234:stdout' };
    expect(shouldRedactProcessStream('stdout', pipe, env, 1234)).toBe(false);
    expect(shouldRedactProcessStream('stderr', pipe, env, 1234)).toBe(true);
  });

  it('only trusts the marker in the direct child of that `varlock run`', () => {
    varlockSettings.redactStdout = true;
    // e.g. `varlock run -- sh -c 'node app.js | tee log'`: node's parent is the shell, and its
    // stdout goes to tee rather than the redacted pipe
    const env = { __VARLOCK_REDACTED_STREAMS: '1234:stdout' };
    expect(shouldRedactProcessStream('stdout', pipe, env, 5678)).toBe(true);
    // a malformed marker is ignored
    expect(shouldRedactProcessStream('stdout', pipe, { __VARLOCK_REDACTED_STREAMS: 'stdout' }, 1234)).toBe(true);
  });
});

describe('patchStreamWrite with a real Writable', () => {
  beforeEach(() => {
    setSecrets({ API_KEY: { value: SECRET } });
  });

  it('writes held-back text before end(), and the write callback succeeds', async () => {
    const chunks: Array<string> = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    patchStreamWrite(stream as any);
    const writeCb = vi.fn();
    stream.write('ends with super-sec', writeCb);
    stream.end('ret-value-12345 tail\n');
    await new Promise((resolve) => {
      stream.on('finish', resolve);
    });
    expect(chunks.join('')).toBe(`ends with ${REDACTED} tail\n`);
    expect(writeCb).toHaveBeenCalledTimes(1);
    expect(writeCb.mock.calls[0][0]).toBeFalsy(); // no error
    // the flush timer must not fire after the stream ended
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(writeCb).toHaveBeenCalledTimes(1);
  });

  it('supports end(cb) with held-back text', async () => {
    const chunks: Array<string> = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    patchStreamWrite(stream as any);
    stream.write('ends with super-sec');
    await new Promise((resolve) => {
      stream.end(resolve);
    });
    expect(chunks.join('')).toBe('ends with super-sec');
  });
});

describe('writes to a stream that can no longer accept them', () => {
  beforeEach(() => {
    setSecrets({ API_KEY: { value: SECRET } });
  });

  for (const [label, close, code] of [
    ['ended', (stream: Writable) => stream.end(), 'ERR_STREAM_WRITE_AFTER_END'],
    ['destroyed', (stream: Writable) => stream.destroy(), 'ERR_STREAM_DESTROYED'],
  ] as const) {
    it(`reports the error for a fully held write after the stream is ${label}`, async () => {
      const stream = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      stream.on('error', () => undefined);
      patchStreamWrite(stream as any);
      close(stream);
      const cb = vi.fn();
      stream.write('super-sec', cb);
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toMatchObject({ code });
    });
  }
});

describe('write errors while text is held back', () => {
  beforeEach(() => {
    setSecrets({ API_KEY: { value: SECRET } });
  });

  for (const autoDestroy of [true, false]) {
    it(`passes the original error to the waiting callback (autoDestroy: ${autoDestroy})`, async () => {
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const stream = new Writable({
        autoDestroy,
        write(_chunk, _encoding, done) {
          setImmediate(() => done(epipe));
        },
      });
      // the stream emits the error too; only the callback is under test
      stream.on('error', () => undefined);
      patchStreamWrite(stream as any);
      const cb = vi.fn();
      // the prefix is written now (and fails), `super-sec` is held back
      stream.write('prefix super-sec', cb);
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toBe(epipe);
    });
  }
});
