/*
  patchGlobalConsole() also patches process stdout/stderr when opted in, so integrations that
  only call it (e.g. vite/astro SSR init) get stream redaction too. Separate file since it
  patches the worker's real console and streams.
*/
import {
  describe, it, expect, afterAll,
} from 'vitest';
import { patchGlobalConsole, unpatchGlobalConsole } from '../patch-console';
import { unpatchStreamWrite } from '../patch-process-streams';
import { isStreamRedactionPatched } from '../lib/stream-patch-key';

describe('patchGlobalConsole', () => {
  const originalEnv = process.env._VARLOCK_REDACT_STDOUT;

  afterAll(() => {
    unpatchStreamWrite(process.stdout as any);
    unpatchStreamWrite(process.stderr as any);
    unpatchGlobalConsole();
    if (originalEnv === undefined) delete process.env._VARLOCK_REDACT_STDOUT;
    else process.env._VARLOCK_REDACT_STDOUT = originalEnv;
  });

  it('patches process stdout/stderr when stdout redaction is enabled', () => {
    process.env._VARLOCK_REDACT_STDOUT = '1';
    delete process.env.__VARLOCK_REDACTED_STREAMS;
    patchGlobalConsole();
    expect(isStreamRedactionPatched(process.stdout)).toBe(true);
    expect(isStreamRedactionPatched(process.stderr)).toBe(true);
  });
});
