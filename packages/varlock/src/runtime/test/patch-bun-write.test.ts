/*
  Bun.write(Bun.stdout, ...) shares holdback state with the patched process stream, but still
  writes with Bun's own writer (so its failures only reject the promise). Bun is stubbed (vitest runs
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

function setup(opts: { bunWriteError?: Error } = {}) {
  const chunks: Array<string> = [];
  const events: Array<string> = [];
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      setTimeout(() => done(), 10);
    },
  });
  stdout.on('error', (err: any) => events.push(`error:${err.code}`));
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  // both writers share the output, like the real fd
  const originalBunWrite = vi.fn(async (_destination: unknown, data: string) => {
    if (opts.bunWriteError) throw opts.bunWriteError;
    chunks.push(data);
    return data.length;
  });
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
    const { bun, chunks } = setup();
    await bun.write(bun.stdout, 'a: super-sec');
    await bun.write(bun.stdout, 'ret-value-12345\n');
    process.stdout.write('b: super-sec');
    await expect(bun.write(bun.stdout, 'ret-value-12345\n')).resolves.toBe('ret-value-12345\n'.length);
    expect(chunks.join('')).toBe('a: su▒▒▒▒▒\nb: su▒▒▒▒▒\n');
  });

  it('a failed Bun.write only rejects its promise (no stream error event)', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const { bun, events } = setup({ bunWriteError: epipe });
    await expect(bun.write(bun.stdout, 'hello\n')).rejects.toBe(epipe);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(events).toEqual([]);
  });
});
