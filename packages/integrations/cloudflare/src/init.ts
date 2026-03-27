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

// load __VARLOCK_ENV — may be a single binding or split into chunks if >5KB
let __varlockEnvJson: string | undefined;
if (__cfEnv?.__VARLOCK_ENV) {
  __varlockEnvJson = __cfEnv.__VARLOCK_ENV as string;
} else if (__cfEnv?.__VARLOCK_ENV_CHUNKS) {
  const chunkCount = parseInt(__cfEnv.__VARLOCK_ENV_CHUNKS as string, 10);
  const parts: Array<string> = [];
  for (let i = 0; i < chunkCount; i++) {
    parts.push((__cfEnv as any)[`__VARLOCK_ENV_${i}`] as string);
  }
  __varlockEnvJson = parts.join('');
}
if (__varlockEnvJson) {
  (globalThis as any).__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
}

(globalThis as any).__varlockThrowOnMissingKeys = true;

initVarlockEnv();
patchGlobalConsole();
patchGlobalResponse();

// Re-export env utilities so consumers can use them without a separate import
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from 'varlock/env';
