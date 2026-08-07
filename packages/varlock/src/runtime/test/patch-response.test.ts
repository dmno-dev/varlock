import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { patchGlobalResponse } from '../patch-response';
import { varlockSettings } from '../env';

describe('patchGlobalResponse', () => {
  let _originalResponse: typeof Response;
  let _originalJsonDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    // afterEach restores this reference, so each test starts from the unpatched native class
    _originalResponse = globalThis.Response;
    _originalJsonDescriptor = Object.getOwnPropertyDescriptor(_originalResponse, 'json');
  });

  afterEach(() => {
    globalThis.Response = _originalResponse;
    // writes through the patched proxy (e.g. `Response.json = wrapper`) land on the native
    // class itself, so restore its original `json` to avoid cross-test pollution
    if (_originalJsonDescriptor) {
      Object.defineProperty(_originalResponse, 'json', _originalJsonDescriptor);
    }
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

  it('keeps the native prototype reachable by reflection (issue #983)', () => {
    const nativeProto = globalThis.Response.prototype;
    const nativeOwnProps = Object.getOwnPropertyNames(nativeProto);

    patchGlobalResponse();

    // srvx's node adapter snapshots globalThis.Response and builds its FastResponse by
    // walking the *own* properties of `Response.prototype`. If we hand it a subclass
    // prototype (which owns nothing but `constructor`) it wires up nothing and its
    // instances fall through to the native getters, which throw on a foreign receiver.
    expect(globalThis.Response.prototype).toBe(nativeProto);
    expect(Object.getOwnPropertyNames(globalThis.Response.prototype)).toEqual(nativeOwnProps);
  });

  it('constructs real native Response instances', () => {
    const NativeResponse = globalThis.Response;
    patchGlobalResponse();

    const r = new globalThis.Response('hello');
    // internal slots are intact only if this is a genuine native instance
    expect(r.status).toBe(200);
    expect(r.body).toBeTruthy();
    expect(Object.getPrototypeOf(r)).toBe(NativeResponse.prototype);
  });

  it('subclasses of the patched Response still work', () => {
    patchGlobalResponse();

    class SubResponse extends globalThis.Response {}
    const r = new SubResponse('hello');
    expect(r instanceof SubResponse).toBe(true);
    expect(r instanceof globalThis.Response).toBe(true);
    expect(r.status).toBe(200);
  });

  it('Response.json returns a usable response', () => {
    patchGlobalResponse();

    const r = globalThis.Response.json({ ok: true });
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r instanceof globalThis.Response).toBe(true);
  });

  it('allows Response.json to be wrapped after patching', () => {
    patchGlobalResponse();
    const previousJson = globalThis.Response.json;
    let wrapperCalled = false;

    globalThis.Response.json = (data, init) => {
      wrapperCalled = true;
      return previousJson(data, init);
    };

    const r = globalThis.Response.json({ ok: true });
    expect(wrapperCalled).toBe(true);
    expect(r instanceof globalThis.Response).toBe(true);
  });

  it('respects a non-configurable Response.json replacement', () => {
    class FakeResponse {
      static json() {
        return 'native';
      }
    }
    globalThis.Response = FakeResponse as unknown as typeof Response;
    patchGlobalResponse();
    Object.defineProperty(globalThis.Response, 'json', {
      value: () => 'replacement',
      configurable: false,
      writable: false,
    });

    expect(globalThis.Response.json({})).toBe('replacement');
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
