---
"varlock": patch
---

fix: `patchGlobalResponse` broke `fetch()` responses failing `instanceof Response` checks. After patching `globalThis.Response` with `VarlockPatchedResponse`, native `fetch()` still returned the original `Response` instances, causing SvelteKit SSR endpoints to throw "handler should return a Response object". Added `Symbol.hasInstance` to `VarlockPatchedResponse` so native responses pass the check.
