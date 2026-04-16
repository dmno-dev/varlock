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
    try {
      globalThis.__varlockLoadedEnv = JSON.parse(__varlockEnvJson);
    } catch (e) {
      throw new Error("[varlock] failed to parse __VARLOCK_ENV: " + e.message);
    }
  }
}
`;
