// Self-contained edge runtime init bundle.
// Initializes varlock env and applies edge-safe patches (console, response).
// Does NOT include patch-server-response which requires node:zlib and node:http.
// Built with noExternal so it can be injected as raw JS or imported from any location.

import { initVarlockEnv } from '../runtime/env';
import { patchGlobalConsole } from '../runtime/patch-console';
import { patchGlobalResponse } from '../runtime/patch-response';
import { isEncryptedBlob, decryptEnvBlobSync } from '../runtime/crypto';

// Decrypt the env blob if it was encrypted at build time.
// Modern edge runtimes (Vercel Edge, Cloudflare with nodejs_compat) support node:crypto,
// so we use the sync version here. Pure Web Crypto async path is available in env.ts as fallback.
if (process.env.__VARLOCK_ENV && isEncryptedBlob(process.env.__VARLOCK_ENV)) {
  const key = process.env._VARLOCK_ENV_KEY;
  if (!key) throw new Error('[varlock] __VARLOCK_ENV is encrypted but _VARLOCK_ENV_KEY is not set');
  process.env.__VARLOCK_ENV = decryptEnvBlobSync(process.env.__VARLOCK_ENV, key);
}

initVarlockEnv();
patchGlobalConsole();
patchGlobalResponse();

// Expose on globalThis so downstream code (e.g. webpack loaders) can re-invoke
// without require() — needed in edge sandboxes that can't resolve bare requires.
(globalThis as any).__varlockPatchConsole = patchGlobalConsole;

// Re-export env utilities so consumers can `import { ENV } from 'varlock/init-edge'`
// without a separate import that would create a second uninitialized module instance.
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from '../runtime/env';
