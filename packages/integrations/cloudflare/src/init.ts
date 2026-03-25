// Cloudflare Workers init module for varlock.
// Import this at the top of your worker entry point to initialize varlock
// from the __VARLOCK_ENV Cloudflare secret binding.
//
// Usage:
//   import '@varlock/cloudflare-integration/init';
//
// This reads __VARLOCK_ENV from Cloudflare's secret bindings, initializes the
// varlock ENV proxy, and applies edge-safe patches (console redaction, response
// leak detection). Does NOT include patchGlobalServerResponse which requires
// node:zlib and node:http.

// @ts-expect-error -- cloudflare:workers is only available in workerd/miniflare runtime
import { env as __cfEnv } from 'cloudflare:workers';

import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalResponse } from 'varlock/patch-response';

if (__cfEnv?.__VARLOCK_ENV) {
  (globalThis as any).__varlockLoadedEnv = JSON.parse(__cfEnv.__VARLOCK_ENV as string);
}

(globalThis as any).__varlockThrowOnMissingKeys = true;

initVarlockEnv();
patchGlobalConsole();
patchGlobalResponse();

// Re-export env utilities so consumers can use them without a separate import
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from 'varlock/env';
