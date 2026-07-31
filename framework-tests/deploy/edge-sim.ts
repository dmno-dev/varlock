/*
  Edge-light simulator: run a vercel-built edge function bundle locally, in a VM
  context that mimics Vercel's Edge runtime, and invoke its handler.

  Why this exists: debugging edge failures on real Vercel is slow (~90s per
  deploy) and blind (runtime logs give error messages with no stack traces).
  This runs the EXACT deployed artifact (.vercel/output/functions/*.func) with
  full stacks and ~10s iteration. It caught, among others: the loader's init
  guard racing async env decryption, and edge process.env writes silently
  no-oping.

  Fidelity notes (learned empirically against real Vercel Edge):
  - NO node:crypto: no process.getBuiltinModule, and require() only resolves a
    small allowlist of builtins (async_hooks etc.) — crypto is NOT in it
  - process.env behaves read-only-ish — writes can silently no-op (we model a
    frozen copy after eval; pass values via the initial env instead)
  - turbopack registers edge modules EAGERLY in a microtask
    (Promise.resolve().then(() => load(module))) — module-eval code races any
    async init, which is why handler gating alone is not enough
  - handlers register on globalThis._ENTRIES (thenable proxy for turbopack,
    plain { default } object for webpack)

  Usage (node >= 23 for native .ts + vm modules):
    cd <app with .vercel/output>   # produced by `vercel build`
    node --experimental-vm-modules ../path/to/edge-sim.ts \
      .vercel/output/functions/middleware.func/index.js \
      --env _VARLOCK_ENV_KEY=<key> \
      --path /middleware-test
*/

import vm from 'node:vm';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

const args = process.argv.slice(2);
const bundlePath = args[0];
if (!bundlePath) {
  console.error('usage: node --experimental-vm-modules edge-sim.ts <bundle.js> [--env K=V ...] [--path /route]');
  process.exit(1);
}
const env: Record<string, string> = {};
let requestPath = '/';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--env') {
    const [k, ...rest] = args[++i].split('=');
    env[k] = rest.join('=');
  } else if (args[i] === '--path') {
    requestPath = args[++i];
  }
}

const code = fs.readFileSync(bundlePath, 'utf8');
const nodeRequire = createRequire(import.meta.url);

// mimic Vercel edge-light's limited require: a few node builtins, NOT crypto
const EDGE_ALLOWED_BUILTINS = ['async_hooks', 'events', 'buffer', 'util', 'assert'];
function edgeRequire(mod: string) {
  const bare = mod.replace(/^node:/, '');
  if (EDGE_ALLOWED_BUILTINS.includes(bare)) return nodeRequire(`node:${bare}`);
  throw new Error(`Native module not found: ${bare}`);
}

const sandbox: Record<string, any> = {
  console,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  URLPattern: (globalThis as any).URLPattern,
  atob,
  btoa,
  crypto: globalThis.crypto, // WebCrypto only — matches edge-light
  Response,
  Request,
  Headers,
  fetch,
  FormData,
  Blob,
  ReadableStream,
  WritableStream,
  TransformStream,
  AbortController,
  AbortSignal,
  EventTarget,
  Event,
  MessageChannel,
  MessageEvent,
  DOMException,
  AsyncLocalStorage,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  performance,
  Promise,
  WeakRef,
  FinalizationRegistry,
  Buffer, // edge-light exposes Buffer via its buffer builtin
  require: edgeRequire,
  process: { env },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  const mod = new (vm as any).SourceTextModule(code, { context: sandbox, identifier: bundlePath });
  await mod.link(() => {
    throw new Error('unexpected import in edge bundle');
  });
  await mod.evaluate();
  console.log('[edge-sim] bundle evaluated OK');
} catch (err: any) {
  console.log('[edge-sim] BUNDLE EVAL THREW:\n', err.stack?.slice(0, 4000));
  process.exit(1);
}

// let eager module-instantiation microtasks race, like on Vercel
await new Promise<void>((r) => {
  setTimeout(r, 0);
});

const entries = sandbox._ENTRIES ?? {};
const entryKey = Object.keys(entries)[0];
if (!entryKey) {
  console.log('[edge-sim] no _ENTRIES registered — is this an edge function bundle?');
  process.exit(1);
}
console.log('[edge-sim] invoking entry:', entryKey);
try {
  // Vercel's launcher accesses .default directly — the entry proxy defers
  // through the module promise internally
  const result = await entries[entryKey].default({
    request: {
      url: `https://edge-sim.local${requestPath}`,
      method: 'GET',
      headers: {},
      nextConfig: { basePath: '', i18n: undefined, trailingSlash: false },
      page: { name: entryKey.replace(/^middleware_/, '/'), params: {} },
      body: null,
    },
  });
  const body = result?.response ? await result.response.text() : '(no response object)';
  console.log('[edge-sim] handler responded. body:');
  console.log(body.slice(0, 1000));
} catch (err: any) {
  console.log('[edge-sim] HANDLER THREW:\n', err.stack?.slice(0, 4000));
  process.exit(1);
}
