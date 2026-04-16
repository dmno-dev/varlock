// Code injected at the top of the SSR entry module so varlock can load its
// resolved env from Cloudflare bindings at runtime.
//
// The `__VARLOCK_ENV` binding (or `__VARLOCK_ENV_CHUNKS` + `__VARLOCK_ENV_<n>`
// chunks when >5KB) is uploaded by `varlock-wrangler deploy`. The body below
// reads whichever form is present and stashes the parsed JSON on
// `globalThis.__varlockLoadedEnv` for `initVarlockEnv()` to pick up.
//
// Two flavors are exported — see each const's docstring.

// Reads `__cfEnv` (the `cloudflare:workers` `env` object) and sets
// `globalThis.__varlockLoadedEnv`.
const LOAD_BODY = `
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
`;

/**
 * Loader for the `@cloudflare/vite-plugin` Workers entry.
 *
 * The entry module (`\0virtual:cloudflare/worker-entry`) is only ever loaded
 * inside the Workers runtime, so a static import of `cloudflare:workers` is
 * safe. Synchronous — no top-level await.
 */
export const CLOUDFLARE_WORKERS_SSR_ENTRY_CODE = `
import { env as __cfEnv } from 'cloudflare:workers';
{
${LOAD_BODY}
}
`;

/**
 * Loader for the SvelteKit + adapter-cloudflare SSR entry
 * (`@sveltejs/kit/.../runtime/server/index.js`).
 *
 * Unlike the Workers-only virtual entry, this module is also dynamically
 * imported by SvelteKit's postbuild prerender/fallback steps in Node — where
 * `import 'cloudflare:workers'` would fail Node's ESM scheme check. So the
 * load is guarded behind a `navigator.userAgent === 'Cloudflare-Workers'`
 * runtime check and wrapped in a dynamic import so Rollup preserves it but
 * Node never resolves it. In Node, `initVarlockEnv()` falls back to
 * `process.env.__VARLOCK_ENV` which the varlock vite plugin sets at config
 * time.
 */
export const SVELTEKIT_CLOUDFLARE_SSR_ENTRY_CODE = `
if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
  const { env: __cfEnv } = await import('cloudflare:workers');
${LOAD_BODY}
}
`;
