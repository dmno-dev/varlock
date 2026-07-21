# @varlock/cloudflare-integration
















## 1.3.2
<sub>2026-07-21</sub>

- [#916](https://github.com/dmno-dev/varlock/pull/916)  *(patch)*
  Stop embedding `.dev.vars` contents in the preview FIFO helper's process argv. Secrets are passed on stdin with a control fd, matching `varlock-wrangler`.
- [#915](https://github.com/dmno-dev/varlock/pull/915)  *(patch)* - Fix .dev.vars quoting so secrets with apostrophes, quotes, and backslashes round-trip correctly through Wrangler

## 1.3.1
<sub>2026-07-20</sub>

- *(patch)* Version bump from `@varlock/vite-integration` v1.3.1

## 1.3.0
<sub>2026-07-15</sub>

- [#881](https://github.com/dmno-dev/varlock/pull/881)  *(minor)*
  Cascaded from @varlock/vite-integration: no longer defaults ssrInjectMode to resolved-env for the Cloudflare adapter (redundant with the native runtime binding loader)
- [#884](https://github.com/dmno-dev/varlock/pull/884)  *(patch)*
  varlock-wrangler dev: skip watching FIFO/non-regular env sources (fixes endless no-op reload logs), and ignore spurious watch events where file mtime is unchanged

## 1.2.1
<sub>2026-07-06</sub>

- *(patch)* Version bump from `@varlock/vite-integration` v1.2.1

## 1.2.0
<sub>2026-06-23</sub>

- [#823](https://github.com/dmno-dev/varlock/pull/823)  *(patch)* - Fix varlock env initialization when using the Astro Cloudflare adapter (@astrojs/cloudflare), including Astro v7. The Astro integration now injects varlock init into the Cloudflare worker entry so ENV works in astro dev and production Workers deployments. Requires `@varlock/cloudflare-integration` when using `@astrojs/cloudflare` (optional peer). varlock now also disables wrangler's redundant `.env` auto-loading (which printed "Using secrets defined in .env" and could shadow varlock's values), since varlock is the source of env for the worker.
- [#827](https://github.com/dmno-dev/varlock/pull/827)  *(patch)* - SvelteKit on Cloudflare now works with the standard varlockVitePlugin() — it auto-detects the @sveltejs/adapter-cloudflare adapter (configured in svelte.config.js or inline in vite.config) and injects the Workers env loader automatically. The same import now works across all deploy targets. varlockSvelteKitCloudflarePlugin is deprecated; install @varlock/cloudflare-integration alongside the vite plugin for Cloudflare deploys.
- *(minor)* Version bump from `@varlock/vite-integration` v1.2.0

## 1.1.7
<sub>2026-06-11</sub>

- [#774](https://github.com/dmno-dev/varlock/pull/774)  *(patch)* - Fix intermittent 'secrets-file contents is not valid' error during wrangler deploy/versions upload in Linux CI. The FIFO that serves resolved env to wrangler re-armed a new writer in a tight loop, so a reader could read multiple concatenated copies of the JSON before seeing EOF. Writers now serve exactly one copy then exit, and a fresh single-shot writer is re-armed once that copy is consumed — only one writer is ever armed at a time (no concatenation), while still supporting wrangler reading the file more than once (e.g. `wrangler types` re-reads the env file). The FIFO is kept so resolved secrets never exist as a file at rest.

## 1.1.6
<sub>2026-06-10</sub>

- [#743](https://github.com/dmno-dev/varlock/pull/743)  *(patch)* - fix(cloudflare): harden varlock-wrangler FIFO server against CI races
  The FIFO server child process now signals readiness on a dedicated
  control pipe (fd 3) before the parent spawns downstream consumers
  (wrangler), eliminating a race where wrangler could open the FIFO
  before the child had buffered content and called the first
  `writeFileSync` to open the FIFO for write — observed in Linux/Docker
  CI environments as `The contents of "/tmp/varlock-secrets-..." is not
  valid`.
  Also:
  - Forward child stderr to the parent so write failures are no longer
    swallowed by a silent `process.exit()`.
  - Surface child write errors with iteration number and error code via
    the control pipe.
  - Fix UTF-8 corruption that could occur when stdin chunks split a
    multi-byte character (use `Buffer.concat` instead of string `+=`).

## 1.1.5
<sub>2026-06-03</sub>

- [#656](https://github.com/dmno-dev/varlock/pull/656)  *(patch)* - add @encryptInjectedEnv and @disableProcessEnvInjection root decorators for encrypted deployments

## 1.1.4
<sub>2026-05-29</sub>

- [#723](https://github.com/dmno-dev/varlock/pull/723)  *(patch)* - Improve env reload feedback in Cloudflare and Next.js integrations, including explicit logs when watched source changes produce no effective env changes.

## 1.1.3
<sub>2026-05-24</sub>

- [#708](https://github.com/dmno-dev/varlock/pull/708) - graceful error handling, error page in dev, stderr piping in varlock-wrangler
- [#708](https://github.com/dmno-dev/varlock/pull/708) - styled html error page for varlock load failures in dev mode

## 1.1.2
<sub>2026-05-13</sub>

- [#702](https://github.com/dmno-dev/varlock/pull/702) - Fix varlock-wrangler: skip unsupported --keep-vars flag for `versions upload`, and propagate wrangler exit code correctly for deploy/types commands.

## 1.1.1
<sub>2026-05-06</sub>

- [#690](https://github.com/dmno-dev/varlock/pull/690) - fix cloudflare + tanstack start + vite 6/7/8 compatibility

## 1.1.0
<sub>2026-05-02</sub>

- [#681](https://github.com/dmno-dev/varlock/pull/681) - Add --summary-stderr/--summary-file flags to varlock load and fullResult option to execSyncVarlock

## 1.0.0
<sub>2026-04-29</sub>

- Updated dependency `varlock` v1.0.0

## 0.1.1

_2026-04-22_

- [#635](https://github.com/dmno-dev/varlock/pull/635) [`2515c80`](https://github.com/dmno-dev/varlock/commit/2515c805562c993ec26786bd1aa097ade5686a50) Thanks [@app/copilot-swe-agent](https://github.com/app/copilot-swe-agent)! - fix(cloudflare): debounce wrangler restarts and skip when env is unchanged
  `varlock-wrangler dev` now caches the serialized resolved env graph and compares it
  after each debounced watch event. Wrangler only restarts when the resolved env has
  actually changed, preventing restart loops caused by spurious `fs.watch()` events
  on macOS (which can emit events even when file contents are identical).
- [#632](https://github.com/dmno-dev/varlock/pull/632) [`9abdffa`](https://github.com/dmno-dev/varlock/commit/9abdffaa894ce887892211960a60af39d02e434b) - pass through exit-code if set from process to avoid silent fails
## 0.1.0

### Minor Changes

- [#622](https://github.com/dmno-dev/varlock/pull/622) [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617) - Add `varlockSvelteKitCloudflarePlugin` for SvelteKit + Cloudflare Workers projects

  New `varlockSvelteKitCloudflarePlugin` exported from `@varlock/cloudflare-integration/sveltekit` for SvelteKit projects deploying via `@sveltejs/adapter-cloudflare`. Unlike `varlockCloudflareVitePlugin`, it does not include `@cloudflare/vite-plugin` (which doesn't support SvelteKit — see [cloudflare/workers-sdk#8922](https://github.com/cloudflare/workers-sdk/issues/8922)). Instead it injects the `cloudflare:workers` runtime env loader into SvelteKit's SSR entry and externalizes the import so Rollup preserves it in the built `_worker.js`. Non-sensitive vars and the `__VARLOCK_ENV` secret are still uploaded via `varlock-wrangler deploy`.

  Also adds a conflict guard to `varlockCloudflareVitePlugin` that errors when the user has manually added `@cloudflare/vite-plugin` to avoid silent double-registration.

### Patch Changes

- Updated dependencies [[`9c38e3a`](https://github.com/dmno-dev/varlock/commit/9c38e3a06977263a43a35aafdd07c8ba4253a6e0), [`f93c23f`](https://github.com/dmno-dev/varlock/commit/f93c23f15d1cb98f64c2d78de1184fb4edbe5582), [`6f90d87`](https://github.com/dmno-dev/varlock/commit/6f90d87bbeb2d82207917ea6b9d809c0d7f8f617)]:
  - varlock@0.9.0

## 0.0.1

### Patch Changes

- [#480](https://github.com/dmno-dev/varlock/pull/480) [`39d88a9`](https://github.com/dmno-dev/varlock/commit/39d88a91be87c7f440e017ff66ebc9c0e5b1c9f9) - New `@varlock/cloudflare-integration` package for Cloudflare Workers

  - `varlockCloudflareVitePlugin()` — Vite plugin that reads secrets from Cloudflare bindings at runtime instead of bundling them into worker code
  - `varlock-wrangler` CLI — drop-in wrangler replacement that uploads non-sensitive values as vars and sensitive values as secrets on deploy; injects env into miniflare via Unix named pipe in dev; watches .env files for changes; generates correct Env types
  - `@varlock/cloudflare-integration/init` — standalone init module for non-Vite workers
    Refactors `@varlock/vite-integration` to remove Cloudflare-specific logic and add generic extension points (`ssrEntryCode`, `ssrEdgeRuntime`, `ssrEntryModuleIds`) for platform integrations.

- Updated dependencies [[`ba61adb`](https://github.com/dmno-dev/varlock/commit/ba61adb19bd5516f0b48827b386fd7170afe66b5), [`6fe325d`](https://github.com/dmno-dev/varlock/commit/6fe325da965c956d1c01c78535c5a5e65524d7a8), [`76c17f8`](https://github.com/dmno-dev/varlock/commit/76c17f8506fb0bd53b5b8d1a87dae25ab517a1ee), [`7f32751`](https://github.com/dmno-dev/varlock/commit/7f327511f8be6a1a3d11e0327adc5d95e2805ad3)]:
  - varlock@0.7.0
