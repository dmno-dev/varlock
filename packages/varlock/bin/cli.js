#!/usr/bin/env node
// The dist bundle is ESM but includes bundled CJS deps (e.g. `ws`) whose
// `require('<node builtin>')` calls run at load via esbuild's interop shim,
// which needs an ambient `require` to exist. Node's ESM loader doesn't provide
// one, so define it before loading the bundle. This must use a dynamic import:
// a static import would hoist above this code and load the bundle first.
import { createRequire } from 'node:module';

if (typeof globalThis.require === 'undefined') {
  globalThis.require = createRequire(import.meta.url);
}
await import('../dist/cli/cli-executable.js');
