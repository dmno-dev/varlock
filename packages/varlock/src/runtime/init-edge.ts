// Self-contained edge runtime init bundle.
// Initializes varlock env and applies edge-safe patches (console, response).
// Does NOT include patch-server-response which requires node:zlib and node:http.
// Built with noExternal so it can be injected as raw JS or imported from any location.

import { initVarlockEnv } from '../runtime/env';
import { patchGlobalConsole } from '../runtime/patch-console';
import { patchGlobalResponse } from '../runtime/patch-response';
import { isEncryptedBlob, decryptEnvBlobSync, decryptEnvBlobAsync } from '../runtime/crypto';

function initNow() {
  initVarlockEnv();
  patchGlobalConsole();
  patchGlobalResponse();
}

/**
 * Gate Next.js edge handler invocation until `ready` resolves.
 *
 * This injected bundle runs at the very top of the edge runtime file, BEFORE the
 * bundler code registers handlers on `globalThis._ENTRIES`, so we install a Proxy
 * that wraps everything subsequently registered. Two registration shapes exist:
 *  - turbopack: `_ENTRIES.middleware_x = <thenable proxy>` — the platform awaits
 *    the entry, so we chain that await behind `ready`
 *  - webpack: `_ENTRIES.middleware_x = { default: handler }` — the platform calls
 *    function properties directly, so we wrap them to await `ready` first
 */
function gateEdgeEntriesUntilReady(ready: Promise<void>) {
  const wrapEntry = (entry: any) => {
    if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) return entry;
    return new Proxy(entry, {
      get(target, prop, receiver) {
        if (prop === 'then' && typeof (target as any).then === 'function') {
          // thenable entry — resolve to the real entry only once env is ready
          // (promise assimilation then awaits the underlying entry itself)
          const chained = ready.then(() => target);
          return chained.then.bind(chained);
        }
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === 'function' && prop !== 'then') {
          return async function gatedEdgeHandler(...args: Array<any>) {
            await ready;
            return val.apply(target, args);
          };
        }
        return val;
      },
    });
  };

  const store: Record<string, any> = {};
  const existing = (globalThis as any)._ENTRIES;
  if (existing) {
    for (const key of Object.keys(existing)) store[key] = wrapEntry(existing[key]);
  }
  const entriesProxy = new Proxy(store, {
    set(target, prop, value) {
      target[prop as string] = wrapEntry(value);
      return true;
    },
  });
  // accessor (not a plain value) because bundler wrappers do
  // `self._ENTRIES = self._ENTRIES || {}` — an assignment even when already set,
  // which would throw on a non-writable property in strict mode. Reassignments
  // funnel their entries through the wrapping proxy instead.
  Object.defineProperty(globalThis, '_ENTRIES', {
    configurable: true,
    get: () => entriesProxy,
    set: (v) => {
      if (v && v !== entriesProxy) {
        for (const key of Object.keys(v)) (entriesProxy as any)[key] = v[key];
      }
    },
  });
}

// Decrypt the env blob if it was encrypted at build time.
// Where node:crypto exists (Cloudflare with nodejs_compat, Next's local edge
// sandbox), we decrypt synchronously before anything else runs. Runtimes without
// it (e.g. Vercel Edge) fall back to async Web Crypto — env init completes in a
// microtask and handler invocation is gated until it does.
const rawEnvBlob = process.env.__VARLOCK_ENV;
if (rawEnvBlob && isEncryptedBlob(rawEnvBlob)) {
  const key = process.env._VARLOCK_ENV_KEY;
  if (!key) throw new Error('[varlock] __VARLOCK_ENV is encrypted but _VARLOCK_ENV_KEY is not set');
  try {
    process.env.__VARLOCK_ENV = decryptEnvBlobSync(rawEnvBlob, key);
    initNow();
  } catch (err) {
    // only fall back for the "runtime has no node:crypto" case — anything else
    // (bad key, corrupt blob) should fail loudly right here
    if (!String((err as Error).message).includes('node:crypto is not available')) throw err;
    const ready = decryptEnvBlobAsync(rawEnvBlob, key).then((decrypted) => {
      // hand the decrypted graph to initVarlockEnv via its globalThis input
      // channel — process.env is read-only in some edge runtimes (e.g. Vercel),
      // so writing the decrypted blob back would silently no-op
      (globalThis as any).__varlockLoadedEnv = JSON.parse(decrypted);
      try {
        process.env.__VARLOCK_ENV = decrypted;
      } catch { /* frozen process.env — the globalThis channel covers init */ }
      initNow();
    });
    // mark rejections handled so a bad key / corrupt blob doesn't surface as an
    // unhandled rejection (fatal on some edge runtimes) before any request runs —
    // gated handlers still await `ready` and surface the real error per-request
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    ready.catch(() => {});
    (globalThis as any).__varlockEnvReady = ready;
    gateEdgeEntriesUntilReady(ready);
  }
} else {
  initNow();
}

// Expose on globalThis so downstream code (e.g. webpack loaders) can re-invoke
// without require() — needed in edge sandboxes that can't resolve bare requires.
(globalThis as any).__varlockPatchConsole = patchGlobalConsole;

// Re-export env utilities so consumers can `import { ENV } from 'varlock/init-edge'`
// without a separate import that would create a second uninitialized module instance.
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from '../runtime/env';
