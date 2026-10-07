/*
  `varlock/patch-console` exposes both patches, and the node entry points (auto-load, init-server,
  integrations) call both. patchGlobalConsole itself must not patch the streams, since the edge
  bundles call it too. Separate file since it patches the worker's real console and streams.
*/
import {
  describe, it, expect, afterAll,
} from 'vitest';
import { patchGlobalConsole, patchProcessStreams, unpatchGlobalConsole } from '../patch-console';
import { unpatchStreamWrite } from '../patch-process-streams';
import { isStreamRedactionPatched } from '../lib/stream-patch-key';

describe('varlock/patch-console', () => {
  const originalEnv = process.env._VARLOCK_REDACT_STDOUT;

  afterAll(() => {
    unpatchStreamWrite(process.stdout as any);
    unpatchStreamWrite(process.stderr as any);
    unpatchGlobalConsole();
    if (originalEnv === undefined) delete process.env._VARLOCK_REDACT_STDOUT;
    else process.env._VARLOCK_REDACT_STDOUT = originalEnv;
  });

  it('patchGlobalConsole leaves the process streams alone', () => {
    process.env._VARLOCK_REDACT_STDOUT = '1';
    delete process.env.__VARLOCK_REDACTED_STREAMS;
    patchGlobalConsole();
    expect(isStreamRedactionPatched(process.stdout)).toBe(false);
    expect(isStreamRedactionPatched(process.stderr)).toBe(false);
  });

  it('patchProcessStreams patches stdout/stderr when stdout redaction is enabled', () => {
    patchProcessStreams();
    expect(isStreamRedactionPatched(process.stdout)).toBe(true);
    expect(isStreamRedactionPatched(process.stderr)).toBe(true);
  });
});
