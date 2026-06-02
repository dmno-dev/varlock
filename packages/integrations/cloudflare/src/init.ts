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
import { isEncryptedBlob, decryptEnvBlobSync } from 'varlock/encrypt-env';

// load __VARLOCK_ENV — may be a single binding or split into chunks if >5KB
let __varlockEnvJson: string | undefined;
if (__cfEnv?.__VARLOCK_ENV) {
  __varlockEnvJson = __cfEnv.__VARLOCK_ENV as string;
} else if (__cfEnv?.__VARLOCK_ENV_CHUNKS) {
  const chunkCount = parseInt(__cfEnv.__VARLOCK_ENV_CHUNKS as string, 10);
  if (!Number.isFinite(chunkCount) || chunkCount < 1 || chunkCount > 1000) {
    throw new Error(`[varlock] invalid __VARLOCK_ENV_CHUNKS value: ${__cfEnv.__VARLOCK_ENV_CHUNKS}`);
  }
  const parts: Array<string> = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = (__cfEnv as any)[`__VARLOCK_ENV_${i}`] as string | undefined;
    if (chunk === undefined || chunk === null) {
      throw new Error(`[varlock] missing chunk __VARLOCK_ENV_${i} (expected ${chunkCount} chunks)`);
    }
    parts.push(chunk);
  }
  __varlockEnvJson = parts.join('');
}
if (__varlockEnvJson) {
  // decrypt if the blob was encrypted, then parse and set for initVarlockEnv
  if (isEncryptedBlob(__varlockEnvJson)) {
    const key = (__cfEnv as any)?._VARLOCK_ENV_KEY as string | undefined;
    if (!key) throw new Error('[varlock] __VARLOCK_ENV is encrypted but _VARLOCK_ENV_KEY binding is not set');
    (globalThis as any).__varlockLoadedEnv = JSON.parse(decryptEnvBlobSync(__varlockEnvJson, key));
  } else {
    (globalThis as any).__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
  }
}

(globalThis as any).__varlockThrowOnMissingKeys = true;

initVarlockEnv();
patchGlobalConsole();
patchGlobalResponse();

// Re-export env utilities so consumers can use them without a separate import
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from 'varlock/env';
