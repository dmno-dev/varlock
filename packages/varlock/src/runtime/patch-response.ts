import { scanForLeaks, varlockSettings } from './env';
import { debug } from './lib/debug';

export function patchGlobalResponse() {
  debug('⚡️ PATCHING global Response');
  if ((globalThis.Response as any)._patchedByVarlock) {
    debug('> already patched');
    return;
  }
  if (varlockSettings.preventLeaks === false) {
    debug('> disabled by settings');
    return;
  }

  const _UnpatchedResponse = globalThis.Response;
  const _UnpatchedResponseJson = _UnpatchedResponse.json;

  function patchedJson(data: any, init: any) {
    debug('⚡️ patched Response.json');
    scanForLeaks(JSON.stringify(data), { method: 'patched Response.json' });
    return Reflect.apply(_UnpatchedResponseJson, _UnpatchedResponse, [data, init]);
  }

  // NOTE - we wrap the native class in a Proxy rather than swapping in a subclass.
  // A subclass would make `globalThis.Response.prototype` a nearly empty object, and
  // libraries that reflect over `Response.prototype`'s own properties to build their own
  // Response-alike (srvx's `lazyInherit`, used by its node adapter) then wire up nothing
  // and fall through to the native getters with a foreign `this`. See issue #983.
  // With a proxy, `Response.prototype` is still the real native prototype, `instanceof`
  // works without a `Symbol.hasInstance` override, and every instance we hand back is a
  // genuine native Response with its internal slots intact.
  globalThis.Response = new Proxy(_UnpatchedResponse, {
    construct(target, args, newTarget) {
      debug('⚡️ patched Response constructor');
      const [body, init] = args;
      const scannedBody = scanForLeaks(body, { method: 'patched Response constructor' });
      return Reflect.construct(target, [scannedBody, init], newTarget);
    },
    get(target, prop, receiver) {
      if (prop === '_patchedByVarlock') return true;
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'json' || value !== _UnpatchedResponseJson) return value;

      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor?.configurable === false && descriptor.writable === false) return value;
      return patchedJson;
    },
    has(target, prop) {
      if (prop === '_patchedByVarlock') return true;
      return Reflect.has(target, prop);
    },
  });
}
