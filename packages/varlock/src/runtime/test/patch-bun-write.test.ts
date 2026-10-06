/*
  Bun.write(Bun.stdout, ...) is routed through the patched process stream, so it shares the
  holdback state and the write queue with process.stdout.write. Bun is stubbed (vitest runs
  on node); process.stdout is swapped for a real Writable. Separate file since it replaces
  globals.
*/
import { Writable } from 'node:stream';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { resetRedactionMap, varlockSettings } from '../env';
import { patchProcessStreams } from '../patch-process-streams';

const SECRET = 'super-secret-value-12345';
const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;

function setup(opts: { failWithCode?: string } = {}) {
  const chunks: Array<string> = [];
  const events: Array<string> = [];
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      const err = opts.failWithCode ? Object.assign(new Error('write failed'), { code: opts.failWithCode }) : undefined;
      setTimeout(() => done(err), 10);
    },
  });
  stdout.on('error', (err: any) => events.push(`error:${err.code}`));
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  const originalBunWrite = vi.fn(async (..._args: Array<unknown>) => 0);
  const bun = { stdout: {}, stderr: {}, write: originalBunWrite };
  (globalThis as any).Bun = bun;
  patchProcessStreams();
  return {
    bun, chunks, events, originalBunWrite,
  };
}

describe('Bun.write to a redacted stream', () => {
  beforeEach(() => {
    resetRedactionMap({ config: { API_KEY: { value: SECRET, isSensitive: true } } } as any);
    varlockSettings.redactStdout = true;
    delete process.env.__VARLOCK_REDACTED_STREAMS;
    delete process.env._VARLOCK_REDACT_STDOUT;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdout', originalStdout);
    delete (globalThis as any).Bun;
    delete varlockSettings.redactStdout;
  });

  it('catches a value split across Bun.write calls and process.stdout.write', async () => {
    const { bun, chunks, originalBunWrite } = setup();
    await bun.write(bun.stdout, 'a: super-sec');
    await bun.write(bun.stdout, 'ret-value-12345\n');
    process.stdout.write('b: super-sec');
    await expect(bun.write(bun.stdout, 'ret-value-12345\n')).resolves.toBe('ret-value-12345\n'.length);
    expect(chunks.join('')).toBe('a: su▒▒▒▒▒\nb: su▒▒▒▒▒\n');
    // text goes through the process stream, not the original Bun.write
    expect(originalBunWrite).not.toHaveBeenCalled();
  });

  it('passes write errors to the write that failed', async () => {
    const { bun, events } = setup({ failWithCode: 'EPIPE' });
    // the prefix is written (and fails), `super-sec` is held back
    process.stdout.write('prefix super-sec', (err: any) => events.push(`callback:${err ? err.code : 'success'}`));
    // the held text then goes out with this write, which fails too
    await expect(bun.write(bun.stdout, 'ret-value-12345\n')).rejects.toBeInstanceOf(Error);
    expect(events[0]).toBe('callback:EPIPE');
    expect(events).toContain('error:EPIPE');
  });
});
