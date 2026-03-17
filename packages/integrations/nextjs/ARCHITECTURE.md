# Next.js Integration — Architecture & Design Notes

This document captures the key design decisions, challenges, and workarounds in the `@varlock/nextjs-integration` package. Next.js has no formal plugin system and its internals vary significantly between Webpack and Turbopack bundlers, so much of this integration relies on carefully timed monkey-patching and code injection.

## Overview

The integration has two main responsibilities:

1. **Load env config** — replace `@next/env` (dotenv-based) with varlock's env loader
2. **Protect secrets at runtime and build time** — patch console, HTTP responses, and build output to prevent sensitive values from leaking

### Entry Points

| Export path | Purpose |
|---|---|
| `.` (default) | `next-env-compat.ts` — drop-in `@next/env` replacement, loads env via `varlock load` |
| `./plugin` | `plugin.ts` — Next.js config plugin, orchestrates webpack/turbopack setup |
| `./loader` | `loader.ts` — webpack/turbopack loader for per-file transforms |

## Key Architecture Decisions

### 1. Shared Redaction State via `globalThis`

**Problem:** Turbopack (and sometimes webpack) can create multiple independent CommonJS bundle instances in the same process. If one instance initializes the redaction map and another instance patches `console.log`, the console patch sees an empty map and secrets pass through unredacted.

**Solution:** All redaction state (`sensitiveSecretsMap`, `redactorFindReplace`) lives on `globalThis.__varlockRedactionState` rather than module-level variables. Every module instance calls `getRedactionState()` which returns the shared object.

### 2. Dual Bundler Support (Webpack vs Turbopack)

Next.js 15+ supports both Webpack and Turbopack. They have fundamentally different compilation models:

- **Webpack:** Single compiler process, `processAssets` hooks for asset manipulation, `DefinePlugin` for static replacements
- **Turbopack:** Rust-based compiler, separate worker processes, loader-only extension point (no asset hooks)

The plugin detects the bundler at config time and branches accordingly. Turbopack detection uses env vars set by Next.js:

```js
const IS_TURBOPACK = !!(
  process.env.TURBOPACK || process.env.TURBOPACK_DEV
  || process.env.TURBOPACK_BUILD || process.env.npm_config_turbopack
);
```

### 3. Init Bundle Injection into Runtime Files

**Problem:** Both bundlers need varlock's initialization (env loading, console patching, response patching) to run before any user code. But the mechanisms differ:

**Webpack approach:** The `processAssets` hook at `PROCESS_ASSETS_STAGE_ADDITIONS` prepends the init bundle (as raw JS wrapped in an IIFE) into `webpack-runtime.js`, `edge-runtime-webpack.js`, etc.

**Turbopack approach:** Turbopack writes `[turbopack]_runtime.js` files during compilation. We patch `fs.promises.writeFile` / `fs.writeFileSync` to detect when build milestone files are written (e.g., `export-detail.json`), then walk `.next/` to find and patch the runtime files.

Both approaches inline `process.env.__VARLOCK_ENV` into the runtime so the deployed server doesn't need a `.env.production.local` file.

### 4. Per-File Init Guards (Loader)

**Problem:** Pre-rendering workers receive compiled code via IPC, not from disk. Runtime file injection doesn't reach them.

**Solution:** The loader injects a tiny guarded snippet into every server-side file:

```js
if(!globalThis.__varlockBuildInit){
  globalThis.__varlockBuildInit=true;
  require('varlock/env').initVarlockEnv();
  require('varlock/patch-console').patchGlobalConsole();
}
```

The `globalThis` guard makes it idempotent — only the first file to execute actually runs initialization.

### 5. Console Re-Patching for React RSC Dev Replay

**Problem:** In webpack dev mode, React wraps `console` methods for RSC dev replay _after_ varlock's initial patch in the runtime file. This means React's wrapper sits between the original console and varlock's redaction, so secrets pass through React's capture unredacted.

**Solution:** The loader adds an _unconditional_ `patchGlobalConsole()` call (outside the once-guard) with `alwaysRepatchConsole: true`. `patchGlobalConsole()` is idempotent — it checks for the `_varlockPatchedFn` marker and no-ops if already wrapping the current function. But if React has re-wrapped console since the last patch, varlock re-wraps React's wrapper.

Turbopack doesn't exhibit this issue because its module evaluation order differs.

### 6. Edge Runtime Handling

Edge runtimes (middleware, edge API routes) can't use `require()` or Node.js builtins (`node:zlib`, `node:http`). This requires a separate init bundle:

- **`init-server`** — full init with `patch-server-response` (uses `node:zlib` for gzip decompression, `node:http` for `ServerResponse`)
- **`init-edge`** — edge-safe init with only `patch-console` and `patch-response` (patches the global `Response` class)

For edge files in the loader, instead of `require()`, we use:
```js
if(globalThis.__varlockPatchConsole) globalThis.__varlockPatchConsole();
```
The `__varlockPatchConsole` function is exposed by the init-edge bundle on `globalThis`.

### 7. Symlinked Package Workaround (Turbopack)

**Problem:** Turbopack can't resolve packages installed via symlinks (e.g., `workspace:*` or `link:` protocols). It resolves the symlink to the real path, then fails to find `node_modules` relative to that path. This is necessary for local development and testing.

**Solution:** When varlock is detected as a symlink in `node_modules/`, the plugin copies the `dist/` directory and `package.json` into `node_modules/.varlock/` (a real directory) and sets up `turbopack.resolveAlias` entries to redirect all `varlock/*` subpath imports there.

### 8. Static ENV Replacements via Proxy

**Problem:** Webpack's `DefinePlugin` config is evaluated once at startup, but env values can change during development (e.g., editing `.env` files).

**Solution:** Instead of passing a plain object to `DefinePlugin`, we pass a `Proxy` that reads from `process.env.__VARLOCK_ENV` on every access. When webpack queries the proxy's keys (via `ownKeys`), it re-parses the latest env data. Only non-sensitive values are replaced statically — sensitive values must go through the runtime `ENV` proxy to ensure redaction.

### 9. Post-Build Leak Scanning & Sourcemap Scrubbing

After the build completes, the plugin:

1. **Scans static chunks** (`.next/static/chunks/**/*.js`) and **prerendered HTML** for leaked secrets. If found, the file is overwritten with a redacted version and the build fails.
2. **Scrubs sourcemaps** (`.next/**/*.map`) by replacing sensitive values with same-length `*` strings. Using same-length replacements preserves column offsets so sourcemaps remain valid.

Scanning is triggered by detecting writes to build milestone files (`prerender-manifest.json`, `next-server.js.nft.json`) via the patched `fs` methods, with a `beforeExit` handler as a safety net.

### 10. Extra File Watchers for `.env.schema`

Next.js only watches a fixed set of `.env*` files for changes. To trigger reloads when `.env.schema` changes, we set up an `fs.watchFile` on `.env.schema` and perform a no-op write to an existing `.env` file (or temporarily create one), which tricks Next.js into reloading.

## Debugging

Set `DEBUG_VARLOCK_NEXT_INTEGRATION=1` to enable verbose debug logging from the plugin, loader, and runtime injection code. The varlock runtime itself uses `DEBUG_VARLOCK=1`.
