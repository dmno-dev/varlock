// Code injected at the top of the SSR entry module so varlock can load its
// resolved env from Cloudflare bindings at runtime.
//
// The `__VARLOCK_ENV` binding (or `__VARLOCK_ENV_CHUNKS` + `__VARLOCK_ENV_<n>`
// chunks when >5KB) is uploaded by `varlock-wrangler deploy`. The body below
// reads whichever form is present and stashes the parsed JSON on
// `globalThis.__varlockLoadedEnv` for `initVarlockEnv()` to pick up.
//
// The `cloudflare:workers` load is guarded behind a
// `navigator.userAgent === 'Cloudflare-Workers'` runtime check and wrapped in
// a dynamic `await import(...)`. This makes the injection safe for SSR entry
// modules that may also be evaluated by Node during a framework's postbuild
// (e.g. SvelteKit prerender/fallback) — Rollup preserves the dynamic import
// but Node never resolves it. Inside Workers the check passes and the load
// runs normally. Overhead vs a static import is one `navigator` check + TLA
// on cold start, which is negligible.
export const CLOUDFLARE_SSR_ENTRY_CODE = `
if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
  const { env: __cfEnv } = await import('cloudflare:workers');
  let __varlockEnvJson;
  if (__cfEnv?.__VARLOCK_ENV) {
    __varlockEnvJson = __cfEnv.__VARLOCK_ENV;
  } else if (__cfEnv?.__VARLOCK_ENV_CHUNKS) {
    const n = parseInt(__cfEnv.__VARLOCK_ENV_CHUNKS, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      throw new Error("[varlock] invalid __VARLOCK_ENV_CHUNKS: " + __cfEnv.__VARLOCK_ENV_CHUNKS);
    }
    const parts = [];
    for (let i = 0; i < n; i++) {
      const chunk = __cfEnv["__VARLOCK_ENV_" + i];
      if (chunk == null) throw new Error("[varlock] missing chunk __VARLOCK_ENV_" + i);
      parts.push(chunk);
    }
    __varlockEnvJson = parts.join("");
  }
  if (__varlockEnvJson) {
    if (__varlockEnvJson.startsWith("varlock:v1:")) {
      // encrypted blob — stash for decryption by the init module
      globalThis.__varlockEncryptedEnv = __varlockEnvJson;
    } else {
      globalThis.__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
    }
  }
}
`;

// --- wrangler .env auto-loading suppression --------------------------------
//
// `@cloudflare/vite-plugin` (used by `wrangler dev`, `vite dev`/`preview`, and
// the `@astrojs/cloudflare` adapter) auto-loads `.env`/`.dev.vars` itself and
// injects the raw values as worker bindings, printing
// `Using secrets defined in .env` as it goes. In a varlock project that's both
// noisy and wrong: varlock already injects the fully-resolved, validated env,
// and the raw `.env` values would shadow it. We opt out of wrangler's loading
// via the documented `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` env var and print
// our own notice in its place.

let noticeLogged = false;

/**
 * Disable wrangler's built-in `.env`/`.dev.vars` auto-loading so it doesn't
 * shadow varlock's resolved env or print "Using secrets defined in .env".
 * Respects an explicit user override of the env var.
 *
 * Must be called before `@cloudflare/vite-plugin` resolves its worker config
 * (the env var is read lazily by wrangler at that point).
 */
export function disableWranglerDotEnvAutoload() {
  if (!('CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV' in process.env)) {
    process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  }
}

/** Print a one-time notice that varlock (not wrangler/`.env`) provides the env. */
export function logVarlockEnvInjectionNotice() {
  if (noticeLogged) return;
  noticeLogged = true;
  // eslint-disable-next-line no-console
  console.log('\x1b[36m🔒 [varlock] injecting resolved env into the Cloudflare worker\x1b[0m');
}
