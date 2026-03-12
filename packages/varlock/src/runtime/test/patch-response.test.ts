import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patchGlobalResponse } from '../patch-response';
import { varlockSettings } from '../env';

describe('patchGlobalResponse', () => {
  let _originalResponse: typeof Response;

  beforeEach(() => {
    _originalResponse = globalThis.Response;
    // ensure the patch is fresh each test
    delete (globalThis.Response as any)._patchedByVarlock;
    globalThis.Response = _originalResponse;
  });

  afterEach(() => {
    globalThis.Response = _originalResponse;
  });

  it('instanceof check passes for native Response instances after patching', () => {
    const NativeResponse = globalThis.Response;
    const nativeInstance = new NativeResponse(null);

    // Before patching: native instance is a Response
    expect(nativeInstance instanceof NativeResponse).toBe(true);

    patchGlobalResponse();

    // After patching: native fetch()-style Response instances should still pass instanceof
    expect(nativeInstance instanceof globalThis.Response).toBe(true);
  });

  it('instanceof check passes for patched Response instances after patching', () => {
    patchGlobalResponse();

    const patchedInstance = new globalThis.Response(null);
    expect(patchedInstance instanceof globalThis.Response).toBe(true);
  });

  it('does not patch twice', () => {
    patchGlobalResponse();
    const patchedOnce = globalThis.Response;
    patchGlobalResponse();
    expect(globalThis.Response).toBe(patchedOnce);
  });

  it('skips patching when preventLeaks is false', () => {
    const original = varlockSettings.preventLeaks;
    try {
      varlockSettings.preventLeaks = false;
      const before = globalThis.Response;
      patchGlobalResponse();
      expect(globalThis.Response).toBe(before);
    } finally {
      varlockSettings.preventLeaks = original;
    }
  });
});
