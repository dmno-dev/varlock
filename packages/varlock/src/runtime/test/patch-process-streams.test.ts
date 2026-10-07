import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { Writable } from 'node:stream';
import { resetRedactionMap, varlockSettings } from '../env';
import { patchStreamWrite, unpatchStreamWrite, shouldRedactProcessStream } from '../patch-process-streams';
import type { SerializedEnvGraph } from '../../env-graph';

const SECRET = 'super-secret-value-12345';
const REDACTED = 'su▒▒▒▒▒';
// what replaces the part of a split value that arrives in the later write
const SPLIT_MASK = '▒▒▒▒▒';
const SPLIT_WARNED_KEY = Symbol.for('varlock.splitValueWarned');

function setSecrets(config: Record<string, { value: string }>) {
  resetRedactionMap({
    config: Object.fromEntries(
      Object.entries(config).map(([key, item]) => [key, { isSensitive: true, ...item }]),
    ),
  } as unknown as SerializedEnvGraph);
}

/** a fake stream recording the arguments each write reaches the underlying write with */
function createFakeStream() {
  const calls: Array<Array<any>> = [];
  const stream = {
    isTTY: false,
    write(...args: Array<any>) {
      calls.push(args);
      return 'original-return-value' as any;
    },
    end(...args: Array<any>) {
      calls.push(['END', ...args]);
    },
  };
  const output = () => calls
    .filter((args) => args[0] !== 'END')
    .map(([chunk]) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')))
    .join('');
  return { stream, calls, output };
}

describe('patchStreamWrite', () => {
  let fake: ReturnType<typeof createFakeStream>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSecrets({ API_KEY: { value: SECRET } });
    fake = createFakeStream();
    patchStreamWrite(fake.stream);
    delete (globalThis as any)[SPLIT_WARNED_KEY];
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    unpatchStreamWrite(fake.stream);
    warn.mockRestore();
  });

  it('redacts strings', () => {
    fake.stream.write(`key=${SECRET}\n`);
    expect(fake.output()).toBe(`key=${REDACTED}\n`);
  });

  it('redacts utf8 buffers (and keeps them buffers)', () => {
    fake.stream.write(Buffer.from(`key=${SECRET}\n`));
    expect(Buffer.isBuffer(fake.calls[0][0])).toBe(true);
    expect(fake.output()).toBe(`key=${REDACTED}\n`);
  });

  it('passes the arguments, callback and return value through unchanged', () => {
    const cb = vi.fn();
    expect(fake.stream.write('hello\n', 'utf8', cb)).toBe('original-return-value');
    expect(fake.calls[0]).toEqual(['hello\n', 'utf8', cb]);
    fake.stream.write(`${SECRET}\n`, cb);
    expect(fake.calls[1]).toEqual([`${REDACTED}\n`, cb]);
  });

  it('holds nothing back: each write goes out right away', () => {
    fake.stream.write('ends with super-sec');
    expect(fake.output()).toBe('ends with super-sec');
  });

  it('masks the rest of a value split across writes, and warns once', () => {
    fake.stream.write('key=super-sec');
    fake.stream.write('ret-value-12345\n');
    expect(fake.output()).toBe(`key=super-sec${SPLIT_MASK}\n`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('API_KEY');
    expect(warn.mock.calls[0][0]).not.toContain(SECRET);

    fake.stream.write('again: super-sec');
    fake.stream.write('ret-value-12345\n');
    expect(fake.output()).toContain(`again: super-sec${SPLIT_MASK}\n`);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('catches a value split across several writes', () => {
    for (const char of SECRET) fake.stream.write(char);
    fake.stream.write('\n');
    // the whole value is never written contiguously
    expect(fake.output()).not.toContain(SECRET);
  });

  it('does not treat a lookalike prefix as a split value', () => {
    fake.stream.write('super-sec');
    fake.stream.write('tion of the docs\n');
    expect(fake.output()).toBe('super-section of the docs\n');
    expect(warn).not.toHaveBeenCalled();
  });

  it('redacts a complete value whose ending is also the start of a value (self-overlap)', () => {
    setSecrets({ SELF_OVERLAP: { value: 'secret-token-s' } });
    fake.stream.write('secret-token-s');
    expect(fake.output()).toBe('se▒▒▒▒▒');
  });

  it('passes binary buffers through untouched', () => {
    const binary = Uint8Array.from([0xFF, 0xFE, 0x00, 0x80]);
    fake.stream.write(binary);
    expect(fake.calls[0][0]).toBe(binary);
  });

  it('passes non-utf8 string encodings through untouched', () => {
    const encoded = Buffer.from(SECRET).toString('base64');
    fake.stream.write(encoded, 'base64');
    expect(fake.calls[0]).toEqual([encoded, 'base64']);
  });

  it('redacts around a multi-byte character split across buffers, keeping its bytes', () => {
    const bytes = Buffer.from(`é ${SECRET}\n`);
    fake.stream.write(bytes.subarray(0, 1)); // first byte of `é`
    fake.stream.write(bytes.subarray(1));
    const written = Buffer.concat(fake.calls.map(([chunk]) => Buffer.from(chunk)));
    expect(written.toString('utf8')).toBe(`é ${REDACTED}\n`);
  });

  it('redacts the final chunk passed to end()', () => {
    const cb = vi.fn();
    fake.stream.end(`bye ${SECRET}\n`, cb);
    expect(fake.calls[0]).toEqual(['END', `bye ${REDACTED}\n`, cb]);
  });

  it('prints values revealed with revealSensitiveConfig (strips the markers)', () => {
    fake.stream.write(`revealed: 👁 ${SECRET} 👁\n`);
    expect(fake.output()).toBe(`revealed: ${SECRET}\n`);
  });

  it('does not double-patch', () => {
    expect(patchStreamWrite(fake.stream)).toBe(false);
  });
});

describe('patchStreamWrite with a real Writable', () => {
  beforeEach(() => {
    setSecrets({ API_KEY: { value: SECRET } });
  });

  function createWritable(opts: { autoDestroy?: boolean, failWith?: Error } = {}) {
    const chunks: Array<string> = [];
    const stream = new Writable({
      autoDestroy: opts.autoDestroy ?? true,
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        setImmediate(() => done(opts.failWith));
      },
    });
    stream.on('error', () => undefined);
    patchStreamWrite(stream as any);
    return { stream, chunks };
  }

  it('redacts writes and end(), with callbacks behaving as usual', async () => {
    const { stream, chunks } = createWritable();
    const writeCb = vi.fn();
    stream.write(`a ${SECRET}\n`, writeCb);
    stream.end(`b ${SECRET}\n`);
    await new Promise((resolve) => {
      stream.on('finish', resolve);
    });
    expect(chunks.join('')).toBe(`a ${REDACTED}\nb ${REDACTED}\n`);
    expect(writeCb).toHaveBeenCalledTimes(1);
    expect(writeCb.mock.calls[0][0]).toBeFalsy();
  });

  for (const autoDestroy of [true, false]) {
    it(`passes write errors to the callback (autoDestroy: ${autoDestroy})`, async () => {
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const { stream } = createWritable({ autoDestroy, failWith: epipe });
      const cb = vi.fn();
      stream.write('prefix super-sec', cb);
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0]).toBe(epipe);
    });
  }

  for (const [label, close, code] of [
    ['ended', (stream: Writable) => stream.end(), 'ERR_STREAM_WRITE_AFTER_END'],
    ['destroyed', (stream: Writable) => stream.destroy(), 'ERR_STREAM_DESTROYED'],
  ] as const) {
    it(`reports the usual error for a write after the stream is ${label}`, async () => {
      const { stream } = createWritable();
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
