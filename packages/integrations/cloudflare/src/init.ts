// Cloudflare Workers init module for varlock.
// Import this at the top of your worker entry point to initialize varlock
// from the __VARLOCK_ENV Cloudflare secret binding.
//
// Usage:
//   import '@varlock/cloudflare-integration/init';
//
// This reads __VARLOCK_ENV from Cloudflare's secret bindings, initializes the
// varlock ENV proxy, and applies varlock's runtime patches (console redaction,
// response leak detection). The sequence is the same one `varlock/auto-init` runs and is
// edge-safe: patches that need node builtins become no-ops where those are missing.

import { initVarlockRuntime } from 'varlock/init';
import { readEnvBlob } from 'varlock/env-blob';

// Frameworks also evaluate the server bundle in Node to prerender, and Node rejects the
// `cloudflare:` scheme. There `varlock/auto-load` has put the same keys in process.env.
// Try the import rather than sniffing `navigator`, which Workers can disable (`no_global_navigator`).
let __cfEnv: Record<string, unknown> | undefined;
try {
  // @ts-expect-error -- cloudflare:workers is only available in workerd/miniflare runtime
  __cfEnv = (await import('cloudflare:workers')).env;
} catch {
  __cfEnv = globalThis.process?.env;
}

// load __VARLOCK_ENV: a single binding, or split into chunks past CF's 5KB secret limit, and
// possibly encrypted (with _VARLOCK_ENV_KEY alongside); the shared reader handles all of it
const __varlockEnvJson = readEnvBlob(__cfEnv ?? {});
if (__varlockEnvJson) {
  (globalThis as any).__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
}

(globalThis as any).__varlockThrowOnMissingKeys = true;

initVarlockRuntime();

// Re-export env utilities so consumers can use them without a separate import
export {
  ENV, redactSensitiveConfig, revealSensitiveConfig, scanForLeaks,
} from 'varlock/env';
