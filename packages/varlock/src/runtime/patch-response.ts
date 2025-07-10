import { scanForLeaks, varlockSettings } from './env';
import { debug } from './lib/debug';

export function patchGlobalResponse() {
  debug('⚡️ PATCHING global Response');
  if (!(globalThis.Response as any)._patchedByVarlock) {
    debug('> already patched');
    return;
  }
  if (varlockSettings.preventLeaks === false) {
    debug('> disabled by settings');
    return;
  }

  const _UnpatchedResponse = globalThis.Response;
  globalThis.Response = class VarlockPatchedResponse extends _UnpatchedResponse {
    static _patchedByVarlock = true;
    constructor(body: any, init: any) {
      debug('⚡️ patched Response constructor');
      super(scanForLeaks(body, { method: 'patched Response constructor' }) as any, init);
    }
    static json(data: any, init: any) {
      debug('⚡️ patched Response.json');
      scanForLeaks(JSON.stringify(data), { method: 'patched Response.json' });
      const r = _UnpatchedResponse.json(data, init);
      Object.setPrototypeOf(r, Response.prototype);
      return r;
    }
  };
}
