/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import MagicString from 'magic-string';

import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';
import { createDebug, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from 'varlock/encrypt-env';

import { createReplacerTransformFn, SUPPORTED_FILES } from '@env-spec/utils/ast-replacer';

import { ansiToHtml } from './ansi-to-html';
export { ansiToHtml };

export function buildErrorPageHtml(ansiError?: string): string {
  const errorContent = ansiError
    ? ansiToHtml(ansiError)
    : 'Config is invalid — check your terminal for details.';

  return `<!DOCTYPE html>
<html><head><title>varlock - config error</title></head>
<body style="font-family: monospace; background: #1e1e2e; color: #cdd6f4; margin: 0; padding: 2rem;">
<div style="margin-bottom: 1.5rem;">
  <h2 style="color: #f38ba8; margin: 0 0 0.5rem 0;">🔒 Varlock — env config validation failed</h2>
  <p style="color: #6c7086; margin: 0;">Your environment variables are loaded and validated by <a href="https://varlock.dev" style="color: #89b4fa;">varlock</a>. Fix the error(s) below and save to reload.</p>
</div>
<pre style="white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; background: #181825; padding: 1rem; border-radius: 8px;">${errorContent}</pre>
</body></html>`;
}


// enables throwing when user accesses a bad key on ENV
(globalThis as any).__varlockThrowOnMissingKeys = true;

// snapshot process.env before varlock modifies it via initVarlockEnv()
const originalProcessEnv = { ...process.env };

const debug = createDebug('varlock:vite-integration');

debug('varlock vite plugin loaded');

let isDevCommand: boolean;
let configIsValid = true;
export let varlockLoadedEnv: SerializedEnvGraph;
/** Stderr output from the last failed varlock load (ANSI-colored) */
export let varlockLastError: string | undefined;
let lastErrorAt = 0;
let configHookCalled = false;
// one-time guard for the SvelteKit+Cloudflare auto-detection notice
let cfDetectNoticeLogged = false;
// one-time guard for the Vercel unencrypted resolved-env warning
let vercelUnencryptedWarningLogged = false;
let staticReplacements: Record<string, any> = {};
let publicDynamicKeys: Array<string> = [];
let replacerFn: ReturnType<typeof createReplacerTransformFn>;


function resetStaticReplacements() {
  staticReplacements = {};
  publicDynamicKeys = [];
  for (const itemKey in varlockLoadedEnv?.config) {
    const itemInfo = varlockLoadedEnv.config[itemKey];
    const isDynamic = itemInfo.isDynamic ?? itemInfo.isSensitive;
    if (isDynamic && !itemInfo.isSensitive) {
      publicDynamicKeys.push(itemKey);
    }
    if (!isDynamic) {
      // we have to pass in a string of 'undefined' so it gets replaced properly
      const val = itemInfo.value === undefined ? 'undefined' : JSON.stringify(itemInfo.value);
      staticReplacements[`ENV.${itemKey}`] = val;
    }
  }
  (globalThis as any).__varlockPublicDynamicKeys = publicDynamicKeys;

  debug('static replacements', staticReplacements);

  replacerFn = createReplacerTransformFn({
    replacements: staticReplacements,
  });
}


// Env sources may not be regular files — e.g. 1Password Environments serves
// `.env` as a FIFO (named pipe) that is re-served on every read. Watching such
// a file is meaningless (its stat churns whenever it is read) and registering
// it in `configFileDependencies` would make vite restart the dev server in a
// loop, since each restart re-reads the pipe and fires new fs events.
function isExistingNonRegularFile(filePath: string): boolean {
  try {
    return !fs.statSync(filePath).isFile();
  } catch {
    return false; // missing files keep their current handling
  }
}

const warnedNonRegularSources = new Set<string>();
function warnNonRegularSourceOnce(absPath: string, basePath?: string) {
  if (warnedNonRegularSources.has(absPath)) return;
  warnedNonRegularSources.add(absPath);
  const displayPath = basePath ? (path.relative(basePath, absPath) || absPath) : absPath;
  console.log(`ℹ️ [varlock] ${displayPath} is not a regular file (FIFO/pipe), live reload is disabled for it`);
}

let loadCount = 0;
let activeIntegrationTelemetry = {
  name: __VARLOCK_INTEGRATION_NAME__,
  version: __VARLOCK_INTEGRATION_VERSION__,
};

/**
 * Directory the current config was loaded from. Tracked so callers can ask for
 * a specific root and only pay for a reload when it actually differs — the
 * module-level load below uses `process.cwd()`, which is not the project root
 * when a framework CLI is pointed elsewhere (e.g. `nuxt build --cwd ./app`).
 */
let loadedConfigDir: string | undefined;

function reloadConfig(cwd?: string) {
  debug('loading config - count =', ++loadCount, cwd ? `(cwd: ${cwd})` : '');
  const prevItemCount = Object.keys(varlockLoadedEnv?.config || {}).length;
  loadedConfigDir = path.resolve(cwd ?? process.cwd());
  try {
    const { stdout } = execSyncVarlock('load --format json-full --compact', {
      fullResult: true,
      env: originalProcessEnv,
      integrationTelemetry: activeIntegrationTelemetry,
      ...(cwd && { cwd }),
    });
    process.env.__VARLOCK_ENV = stdout;
    varlockLoadedEnv = JSON.parse(stdout) as SerializedEnvGraph;
    varlockLastError = undefined;
    lastErrorAt = 0;
    configIsValid = true;
  } catch (err) {
    // CLI exits non-zero on validation failure but still outputs JSON to stdout.
    // Try to parse it so we have sources (for file watching) and error details.
    if (err instanceof VarlockExecError) {
      if (err.stdout) {
        try {
          varlockLoadedEnv = JSON.parse(err.stdout) as SerializedEnvGraph;
          // Set __VARLOCK_ENV even on failure so `varlock/env` can initialize
          // with partial data (prevents "ENV not initialized" throws)
          process.env.__VARLOCK_ENV = err.stdout;
        } catch { /* not parseable — hard failure */ }
      }
      if (err.stderr) {
        // Debounce identical errors — frameworks like Astro can trigger
        // multiple rapid reloads. But if some time has passed, show it
        // again (the user may have re-introduced the same error).
        const now = Date.now();
        const isDuplicate = err.stderr === varlockLastError && (now - lastErrorAt) < 5000;
        varlockLastError = err.stderr;
        lastErrorAt = now;
        if (!isDuplicate) {
          console.error(err.stderr);
          console.error('\n[varlock] ⚠️ config is invalid — fix the error(s) above to continue\n');
        }
      }
    }
    configIsValid = false;
    resetStaticReplacements();
    return;
  }

  // Reloading from a different directory can silently wipe a working config if
  // that directory has no schema — `varlock load` succeeds there and returns an
  // empty graph, which then disables every static replacement. Surface it
  // instead of letting the build produce a broken bundle.
  if (cwd && prevItemCount > 0 && Object.keys(varlockLoadedEnv?.config || {}).length === 0) {
    console.warn(
      `\x1b[33m[varlock] ⚠️  no env items found when loading from ${cwd}\x1b[0m\n`
      + 'This directory has no `.env.schema`, so `ENV.*` references will not be replaced at build time.\n'
      + "If your framework points vite's `root` at a source subdirectory, the integration should pass "
      + '`rootDir` to `varlockVitePlugin()`.',
    );
  }

  // If a runtime auto-load already populated the global (e.g. `varlock/auto-load`
  // imported in nuxt.config), refresh it with the newly resolved graph -
  // initVarlockEnv prefers it over the process.env blob, so a stale copy would
  // pin the old values through every re-init.
  if ((globalThis as any).__varlockLoadedEnv) {
    (globalThis as any).__varlockLoadedEnv = varlockLoadedEnv;
  }

  // initialize varlock and patch globals as necessary
  initVarlockEnv();
  // these will be no-ops if these are disabled by settings
  patchGlobalConsole();
  patchGlobalServerResponse();
  patchGlobalResponse();

  resetStaticReplacements();
}

// we run this right away so the globals get injected into the vite.config file
reloadConfig();


export interface VarlockVitePluginOptions {
  /** controls if/how varlock init code is injected into the built SSR application code */
  ssrInjectMode?: 'auto-load' | 'init-only' | 'resolved-env',
  /** extra code lines to inject at the SSR entry point, before varlock init calls */
  ssrEntryCode?: Array<string>,
  /** set to true for edge runtimes that don't have node:http (skips patchGlobalServerResponse) */
  ssrEdgeRuntime?: boolean,
  /** additional virtual module IDs to treat as entry points (e.g., '\0virtual:cloudflare/worker-entry') */
  ssrEntryModuleIds?: Array<string>,
  /** override integration identity for CLI telemetry (used by composed integrations like Astro) */
  integrationTelemetry?: { name: string, version: string },
  /**
   * set by composed integrations (e.g. `@varlock/cloudflare-integration`, the
   * Astro Cloudflare adapter branch) when the CF runtime env loader has been
   * injected via `ssrEntryCode`. Used to reject `ssrInjectMode: 'resolved-env'`
   * as redundant — the loader already hydrates env from Cloudflare bindings.
   */
  isCloudflareTarget?: boolean,
  /**
   * directory varlock should load `.env` files from. Defaults to vite's `root`.
   * Set by integrations whose framework points vite's `root` at a source
   * subdirectory rather than the project root — e.g. Nuxt 4, where `root` is
   * the `app/` srcDir but the env files live one level up.
   */
  rootDir?: string,
}

/** options for {@link buildVarlockSsrInitCode} */
/**
 * The currently loaded env graph, for integrations that need to inspect the
 * config outside vite's hooks (e.g. the Nuxt module checks for public+dynamic
 * items to decide whether to inject the public-env endpoint). Reloads the
 * config first if `rootDir` differs from the directory the module-level load
 * used.
 */
export function getVarlockLoadedEnv(rootDir?: string): SerializedEnvGraph | undefined {
  if (rootDir && path.resolve(rootDir) !== loadedConfigDir) {
    reloadConfig(rootDir);
  }
  return varlockLoadedEnv;
}

/**
 * Force a fresh env resolution and refresh the shared runtime store (ENV proxy
 * values, process.env injection, the auto-load global). Used by the Nuxt module
 * on dev restarts: it runs before the new nuxt instance evaluates nuxt.config,
 * so config-time `ENV` reads see fresh values even though the config's cached
 * `varlock/auto-load` import does not re-run.
 */
export function refreshVarlockEnv(rootDir?: string) {
  reloadConfig(rootDir ?? loadedConfigDir);
}

/**
 * Absolute paths of the env files the current config was loaded from, for
 * integrations that manage their own file watching (e.g. the Nuxt module
 * pushes these into `nuxt.options.watch` so a schema edit restarts the dev
 * server). Reloads the config first if `rootDir` differs from the directory
 * the module-level load used. Non-regular files (FIFOs, e.g. 1Password
 * Environments) are excluded since watching them is meaningless.
 */
export function getVarlockEnvSourcePaths(rootDir?: string): Array<string> {
  getVarlockLoadedEnv(rootDir);
  const paths: Array<string> = [];
  if (!varlockLoadedEnv?.basePath) return paths;
  for (const source of varlockLoadedEnv.sources) {
    if (!source.enabled || !source.path) continue;
    const absPath = path.resolve(varlockLoadedEnv.basePath, source.path);
    if (isExistingNonRegularFile(absPath)) continue;
    paths.push(absPath);
  }
  return paths;
}

export interface VarlockSsrInitCodeOptions {
  ssrInjectMode?: VarlockVitePluginOptions['ssrInjectMode'],
  ssrEntryCode?: VarlockVitePluginOptions['ssrEntryCode'],
  ssrEdgeRuntime?: VarlockVitePluginOptions['ssrEdgeRuntime'],
  isCloudflareTarget?: VarlockVitePluginOptions['isCloudflareTarget'],
  /** vite environment name — only used to detect Cloudflare's prerender worker */
  environmentName?: string,
  /** overrides the dev/build detection, for callers that run outside vite's `config` hook */
  isDev?: boolean,
  /**
   * directory to load `.env` files from. Callers that run before vite's
   * `config` hook must pass this — until that hook runs, the config is
   * whatever the module-level load found in `process.cwd()`, which is not the
   * project root when a framework CLI is pointed elsewhere (`nuxt build --cwd`).
   */
  rootDir?: string,
  /**
   * emit side-effect-only imports in a form that cannot be tree-shaken. Set by
   * integrations targeting a bundler that treats external modules as
   * side-effect free — Nitro's rollup pass drops a bare `import 'x'` of an
   * external, which would silently disable `ssrInjectMode: 'auto-load'`.
   */
  preserveSideEffectImports?: boolean,
}

/**
 * Builds the varlock init module source — the code that initializes `ENV` and
 * patches the global console/response objects before any user code runs.
 *
 * Exported so integrations can inject the same init sequence into build
 * pipelines that vite does not own. `@varlock/nuxt-integration` uses it for the Nitro
 * server bundle, which rollup builds separately from vite's SSR output.
 */
export function buildVarlockSsrInitCode(opts: VarlockSsrInitCodeOptions = {}): string {
  // `resolved-env` serializes the loaded config straight into the artifact, so
  // a config loaded from the wrong directory bakes an empty env into the build.
  if (opts.rootDir && path.resolve(opts.rootDir) !== loadedConfigDir) {
    reloadConfig(opts.rootDir);
  }

  let ssrInjectMode = opts.ssrInjectMode ?? 'init-only';
  const isCloudflareTarget = opts.isCloudflareTarget ?? false;
  const isDev = opts.isDev ?? isDevCommand;

  // Cloudflare's build-time prerender worker (@astrojs/cloudflare v14 runs
  // prerendering inside workerd via @cloudflare/vite-plugin's experimental
  // `prerenderWorker`, a vite environment named "prerender") executes during
  // the build with no bindings attached, so the runtime bindings loader can
  // never find env there and `process.env.__VARLOCK_ENV` doesn't exist inside
  // workerd. Bake the resolved env directly instead by routing this env
  // through the same `resolved-env` path used below (so it shares the init +
  // patch sequence and any future additions to it) — this artifact only
  // generates static HTML at build time and is not deployed, and generated
  // HTML is still leak-scanned by the framework integrations. The three
  // guards keyed off `isCfPrerenderEnv` opt it out of the CF-specific
  // behaviors that don't apply to the throwaway prerender worker: the
  // "redundant on CF" rejection, env encryption (the worker can't read
  // `_VARLOCK_ENV_KEY`, and the artifact is discarded), and the CF bindings
  // loader (whose top-level `await import('cloudflare:workers')` + absent
  // bindings are exactly what break the build here).
  const isCfPrerenderEnv = isCloudflareTarget && opts.environmentName === 'prerender' && !isDev;
  if (isCfPrerenderEnv) ssrInjectMode = 'resolved-env';

  const isEdgeRuntime = opts.ssrEdgeRuntime ?? false;
  const lines: Array<string> = [
    '// Virtual module generated by @varlock/vite-integration',
    '// Runs before any user code to ensure ENV is available at module top-level',
    'globalThis.__varlockThrowOnMissingKeys = true;',
    `globalThis.__varlockPublicDynamicKeys = ${JSON.stringify(publicDynamicKeys)};`,
  ];

  const encryptionRequired = varlockLoadedEnv?.settings?.encryptInjectedEnv;
  // Force plaintext for the prerender worker — it can't read _VARLOCK_ENV_KEY
  // (no bindings) and is discarded after the build, so an encrypted blob would
  // only fail to decrypt.
  let encryptionKey: string | undefined = isCfPrerenderEnv ? undefined : process.env._VARLOCK_ENV_KEY;

  if (ssrInjectMode === 'auto-load') {
    if (opts.preserveSideEffectImports) {
      // binding the namespace to a global makes the import observably used, so
      // a bundler treating externals as side-effect free can't drop it
      lines.push(
        "import * as __varlockAutoLoad from 'varlock/auto-load';",
        'globalThis.__varlockAutoLoadModule = __varlockAutoLoad;',
      );
    } else {
      lines.push("import 'varlock/auto-load';");
    }
  } else {
    if (ssrInjectMode === 'resolved-env') {
      // Only reject this for production builds. In dev, some adapters (e.g.
      // Astro's @astrojs/cloudflare) run SSR inside workerd via a plugin-owned
      // miniflare instance with no binding-injection hook for varlock to use,
      // so resolved-env is the only way to get real values into the worker —
      // it's the composed integration's own default there, not shipped in a
      // deploy artifact.
      if (isCloudflareTarget && !isDev && !isCfPrerenderEnv) {
        throw new Error(
          "[varlock] ssrInjectMode: 'resolved-env' is redundant on Cloudflare Workers and ships resolved "
          + '(possibly sensitive) values into the worker bundle unnecessarily. Cloudflare deploys get their '
          + 'env injected at runtime from bindings via `varlock-wrangler` — remove the `ssrInjectMode` override '
          + "(or set it to 'init-only') and let the Cloudflare integration handle it.\n"
          + 'See https://varlock.dev/integrations/cloudflare/ for details.',
        );
      }
      // Vercel has no native runtime-binding mechanism like Cloudflare's, so
      // `resolved-env` is the correct approach there — but plaintext means
      // secrets sit as JSON in the build artifact. Nudge (don't block) users
      // who haven't opted into `@encryptInjectedEnv`.
      if (process.env.VERCEL === '1' && !encryptionRequired && !isDev) {
        if (!vercelUnencryptedWarningLogged) {
          vercelUnencryptedWarningLogged = true;
          console.warn(
            "\x1b[33m[varlock] ⚠️ ssrInjectMode: 'resolved-env' on Vercel ships your resolved env as plaintext JSON "
            + 'in the build artifact. Consider enabling `@encryptInjectedEnv` — '
            + 'see https://varlock.dev/guides/encrypted-deployments/\x1b[0m',
          );
        }
      }
      if (encryptionRequired && !encryptionKey && !isCfPrerenderEnv) {
        if (isDev) {
          // auto-generate a temporary key for local dev
          encryptionKey = generateEncryptionKeyHex();
          process.env._VARLOCK_ENV_KEY = encryptionKey;
        } else {
          throw new Error(
            '[varlock] @encryptInjectedEnv is enabled but _VARLOCK_ENV_KEY is not set.\n'
            + 'Generate a key with `varlock generate-key` and set it on your platform.\n'
            + 'See https://varlock.dev/guides/encrypted-deployments/ for details.',
          );
        }
      }
      // `injectedAtBuild: 'explicit'` marks the payload itself as resolved at BUILD
      // time by user choice (`resolved-env` is opt-in bake-into-build). Runtime env
      // values conflicting with it never had a chance to act as overrides and cannot
      // be validated now - initVarlockEnv surfaces them as a loud warning but boots
      // on the baked values (the declared contract), unlike the 'fallback' mode used
      // by implicit baking, which fails the boot. Living inside the payload, the
      // provenance survives encryption and never outlives the payload.
      const serialized = JSON.stringify({ ...varlockLoadedEnv, injectedAtBuild: 'explicit' });
      // a blob already present in the runtime env (fresh boot-time resolution via
      // `varlock run`) wins over the baked payload, matching the Next.js preludes -
      // otherwise the conflict warning's `varlock run` remedy could never work.
      // Note statically-inlined (non-sensitive, non-dynamic) values are replaced at
      // build time regardless; the fresh blob governs runtime-resolved reads.
      const skipIfAmbientBlob = "if (typeof process === 'undefined' || !process.env.__VARLOCK_ENV) ";
      if (encryptionKey) {
        const encrypted = encryptEnvBlobSync(serialized, encryptionKey);
        lines.push(`${skipIfAmbientBlob}globalThis.__varlockEncryptedEnv = ${JSON.stringify(encrypted)};`);
      } else {
        lines.push(`${skipIfAmbientBlob}globalThis.__varlockLoadedEnv = ${serialized};`);
      }
    }

    // inject custom entry code from integrations (e.g., CF bindings loader) —
    // but not in the prerender worker, where the runtime bindings loader can't
    // work and its top-level await breaks the build (env is baked in above).
    if (opts.ssrEntryCode?.length && !isCfPrerenderEnv) {
      lines.push(...opts.ssrEntryCode);
    }

    // decrypt the encrypted env blob before initVarlockEnv runs
    lines.push(
      "import { initVarlockEnv } from 'varlock/env';",
      "import { patchGlobalConsole } from 'varlock/patch-console';",
      "import { patchGlobalResponse } from 'varlock/patch-response';",
    );
    // always include decryption support — the blob may be encrypted at build time
    // (via _VARLOCK_ENV_KEY) or at deploy time (e.g., Cloudflare varlock-wrangler)
    lines.push(
      "import { decryptEnvBlobSync } from 'varlock/encrypt-env';",
      'if (globalThis.__varlockEncryptedEnv) {',
      '  const __key = typeof process !== \'undefined\' && process.env._VARLOCK_ENV_KEY;',
      "  if (!__key) throw new Error('[varlock] encrypted env blob present but _VARLOCK_ENV_KEY is not set');",
      '  globalThis.__varlockLoadedEnv = JSON.parse(decryptEnvBlobSync(globalThis.__varlockEncryptedEnv, __key));',
      '  delete globalThis.__varlockEncryptedEnv;',
      '}',
    );
    if (!isEdgeRuntime) {
      lines.push("import { patchGlobalServerResponse } from 'varlock/patch-server-response';");
    }
    lines.push(
      'initVarlockEnv();',
      'patchGlobalConsole();',
    );
    if (!isEdgeRuntime) {
      lines.push('patchGlobalServerResponse();');
    }
    lines.push('patchGlobalResponse();');
  }

  return lines.join('\n');
}

// Return type is `any` instead of `Plugin` to avoid symlink type conflicts.
// When this package is symlinked for local dev, TypeScript resolves `vite`'s
// Plugin type from this package's node_modules — a different copy than the
// consumer's — causing spurious type errors. Since Vite's `plugins` config
// is loosely typed, this is functionally equivalent.
const VARLOCK_INIT_MODULE_ID = '\0varlock-ssr-init';

export function varlockVitePlugin(
  vitePluginOptions?: VarlockVitePluginOptions,
): any {
  if (vitePluginOptions?.integrationTelemetry) {
    const prevName = activeIntegrationTelemetry.name;
    activeIntegrationTelemetry = vitePluginOptions.integrationTelemetry;
    if (prevName !== activeIntegrationTelemetry.name) {
      // reload from wherever the config currently comes from — falling back to
      // cwd here would drop a root an integration already corrected
      reloadConfig(vitePluginOptions.rootDir ?? loadedConfigDir);
    }
  }

  // Resolved at build time. These start from the passed options but may be
  // overridden by SvelteKit+Cloudflare auto-detection in `configResolved`
  // (see below). They're read lazily by `buildInitModuleCode()`, which runs
  // when the virtual init module is loaded — always after `configResolved`.
  let resolvedSsrEdgeRuntime = vitePluginOptions?.ssrEdgeRuntime ?? false;
  let resolvedSsrEntryCode = vitePluginOptions?.ssrEntryCode;
  let resolvedIsCloudflareTarget = vitePluginOptions?.isCloudflareTarget ?? false;

  // Build the virtual init module content. This module is imported by SSR
  // entry points and evaluates before any user code because it has no
  // transitive dependencies on user modules.
  function buildInitModuleCode(environmentName?: string) {
    return buildVarlockSsrInitCode({
      ssrInjectMode: vitePluginOptions?.ssrInjectMode,
      ssrEntryCode: resolvedSsrEntryCode,
      ssrEdgeRuntime: resolvedSsrEdgeRuntime,
      isCloudflareTarget: resolvedIsCloudflareTarget,
      environmentName,
    });
  }

  // Auto-detect SvelteKit deploying to Cloudflare Workers and wire up the edge
  // env-loader so users don't need a separate import. SvelteKit resolves its
  // config (from `svelte.config.js` OR inline `sveltekit({ adapter })`) and
  // exposes it on the `vite-plugin-sveltekit-setup` plugin's `api.options`, so
  // this one check covers both config layouts. The Cloudflare-specific injected
  // code lives in `@varlock/cloudflare-integration` and is pulled in lazily via
  // a runtime dynamic import. CF deployers already have it installed (it ships
  // `varlock-wrangler`); it is intentionally NOT declared as a (peer)dependency
  // here because cloudflare-integration depends on vite-integration, and the
  // back-edge would create a build/typecheck cycle. We skip this when the
  // consumer already supplied
  // `ssrEntryCode` (e.g. the astro integration or the legacy
  // `varlockSvelteKitCloudflarePlugin`) so we never double-inject.
  async function detectSvelteKitCloudflareTarget(config: { plugins?: ReadonlyArray<any> }) {
    if (resolvedSsrEntryCode) return;

    // SvelteKit's setup plugin (`vite-plugin-sveltekit-setup`) exposes the
    // resolved config via `api.options`. Match structurally on the
    // `kit.adapter` shape rather than the plugin name so this is resilient to
    // version changes — only SvelteKit exposes a resolved adapter this way.
    const sveltekitSetup = config.plugins?.find((p) => p?.api?.options?.kit?.adapter);
    if (!sveltekitSetup) return;

    const adapterName: string | undefined = sveltekitSetup.api.options.kit.adapter?.name;
    // `adapter-auto` keeps its own name even when it resolves to Cloudflare in
    // CF's CI, so fall back to the platform env vars CF sets at build time.
    const isCloudflare = adapterName === '@sveltejs/adapter-cloudflare'
      || (adapterName === '@sveltejs/adapter-auto' && !!(process.env.CF_PAGES || process.env.WORKERS_CI));
    if (!isCloudflare) return;

    try {
      // Variable specifier + cast: keeps this a runtime-only dynamic import so
      // typecheck/bundling don't require the (optional) package to be present.
      const cfEntryCodeModule = '@varlock/cloudflare-integration/ssr-entry-code';
      const { CLOUDFLARE_SSR_ENTRY_CODE } = await import(cfEntryCodeModule) as { CLOUDFLARE_SSR_ENTRY_CODE: string };
      resolvedSsrEntryCode = [CLOUDFLARE_SSR_ENTRY_CODE];
      resolvedSsrEdgeRuntime = true;
      resolvedIsCloudflareTarget = true;
      debug('detected SvelteKit + Cloudflare adapter — injecting edge env loader');
      // Surface the auto-detection so it isn't silent magic in the build output.
      if (!cfDetectNoticeLogged) {
        cfDetectNoticeLogged = true;
        console.log('\x1b[36m🔒 [varlock] detected @sveltejs/adapter-cloudflare — injecting the Cloudflare Workers env loader into the SSR entry\x1b[0m');
      }
    } catch {
      throw new Error(
        '[varlock] SvelteKit deploying to Cloudflare requires @varlock/cloudflare-integration.\n'
        + 'Install it alongside @varlock/vite-integration: npm install @varlock/cloudflare-integration',
      );
    }
  }

  return {
    name: 'inject-varlock-config',
    enforce: 'post',

    resolveId(id) {
      if (id === VARLOCK_INIT_MODULE_ID) return id;
    },
    load(id) {
      if (id === VARLOCK_INIT_MODULE_ID) {
        // `this.environment` exists in vite 6+ (environments API)
        return buildInitModuleCode(this.environment?.name);
      }
    },

    // hook to modify config before it is resolved
    async config(config, env) {
      debug('vite plugin - config fn called, loadCount =', loadCount, 'command =', env.command);

      // warn if the user has set envDir - varlock ignores this option
      // and instead reads env files from cwd (or the path configured in package.json)
      if (config.envDir) {
        console.warn(`
[varlock] ⚠️  The \`envDir\` Vite option is not supported by varlock.
To load .env files from a custom directory, set \`varlock.loadPath\` in your \`package.json\`:

  {
    "varlock": {
      "loadPath": "./your-env-dir/"
    }
  }

See https://varlock.dev/integrations/vite/ for more details.
`);
      }

      isDevCommand = env.command === 'serve';
      if (env.command === 'build') {
        process.env.__VARLOCK_EXECUTION_PHASE = 'build';
      } else {
        delete process.env.__VARLOCK_EXECUTION_PHASE;
      }

      // Determine the project root for the current Vite/Vitest project.
      // In monorepo setups with Vitest workspace projects, config.root
      // points to the child package directory rather than the monorepo root
      // where process.cwd() points. We need to reload varlock from the
      // correct directory so it can find .env.schema and .env files.
      // An integration can override this via `rootDir` when its framework
      // points vite's `root` at a source subdirectory instead of the project
      // root (e.g. Nuxt 4, whose `root` is the `app/` srcDir).
      const rootDirSource = vitePluginOptions?.rootDir ?? config.root;
      const projectRoot = rootDirSource ? path.resolve(rootDirSource) : undefined;
      // Compare against where the config was actually loaded from, not cwd —
      // an integration may already have reloaded from `projectRoot` before this
      // hook ran (see `buildVarlockSsrInitCode`), and cwd is not the project
      // root when a framework CLI is pointed elsewhere (`nuxt build --cwd`).
      const rootDiffersFromLoaded = !!(projectRoot && projectRoot !== loadedConfigDir);

      if (rootDiffersFromLoaded) {
        // Reload with the correct project root. This handles monorepo
        // Vitest workspace setups where each child project has its own
        // env files — the module-level load used cwd which may be wrong.
        reloadConfig(projectRoot);
      } else if (!configHookCalled) {
        // First config hook call — the config was already loaded from the
        // correct directory, no need to reload.
        configHookCalled = true;
      } else if (isDevCommand) {
        // Dev mode restart (triggered by configFileDependencies change).
        // The module stays cached so the module-level reloadConfig()
        // doesn't re-run — we need to reload here, from the same directory
        // the current config came from rather than cwd.
        reloadConfig(projectRoot ?? loadedConfigDir);
      }

      // we do not want to inject via config.define - instead we use @rollup/plugin-replace

      const hasCfPlugin = config.plugins?.flat().some((p: any) => p?.name?.includes('cloudflare'));

      if (!configIsValid) {
        if (isDevCommand) {
          // adjust vite's setting so it doesnt bury the error messages
          config.clearScreen = false;
        } else {
          console.error('\n[varlock] config is invalid — cannot proceed with build\n');
          process.exit(1);
        }
      }

      if (!hasCfPlugin) {
        // Keep the `cloudflare:workers` runtime import that the SvelteKit+Cloudflare
        // env loader injects into the SSR entry (see configResolved). The adapter
        // isn't resolvable this early, so we add it whenever the CF Vite plugin is
        // absent — it's inert unless something actually imports the specifier
        // (Rollup only externalizes specifiers that appear in the module graph).
        // When the CF Vite plugin IS present (non-SvelteKit CF setups) it manages
        // `cloudflare:*` externals itself, so we stay out of its way. Returned as a
        // partial config so Vite's mergeConfig folds it into any existing externals.
        return { build: { rollupOptions: { external: ['cloudflare:workers'] } } };
      }
    },
    // hook to observe/modify config after it is resolved
    async configResolved(config) {
      debug('vite plugin - configResolved fn called');

      await detectSvelteKitCloudflareTarget(config);

      if (!varlockLoadedEnv) return;
      // inject all .env files that varlock loaded into `configFileDependencies`
      // so that vite will watch them and reload if they change
      for (const varlockSource of varlockLoadedEnv.sources) {
        if (!varlockSource.enabled) continue;
        if (varlockLoadedEnv.basePath && varlockSource.path) {
          const absPath = path.resolve(varlockLoadedEnv.basePath, varlockSource.path);
          if (isExistingNonRegularFile(absPath)) {
            warnNonRegularSourceOnce(absPath, varlockLoadedEnv.basePath);
            continue;
          }
          config.configFileDependencies.push(absPath);
        }
      }
    },
    // hook to configure vite dev server
    async configureServer(server) {
      debug('vite plugin - configureServer fn called');

      // Always register middleware — check configIsValid dynamically on each
      // request so the error page appears/disappears as config is fixed/broken
      server.middlewares.use((req, res, next) => {
        if (configIsValid) return next();
        // skip HMR websocket and vite internal requests
        if (req.url?.startsWith('/@')) return next();

        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(buildErrorPageHtml(varlockLastError));
      });
    },

    transform(code, id, options) {
      // replace build-time ENV.x references
      let magicString = replacerFn(this, code, id);

      // Detect dev vs build.
      // Use the environment API (vite 6+), falling back to command check (vite 5).
      const isDevEnv = this.environment ? this.environment.mode === 'dev' : isDevCommand;

      // Detect if this module is an entry point so we can inject varlock init.
      // For regular files: try isEntry (build mode), fall back to moduleIds[0] (dev).
      // For virtual modules: check ssrEntryModuleIds from integrations (e.g. CF plugin).
      const fileExt = id.split('?')[0].split('#')[0].split('.').pop() || '';
      let isEntry = false;
      if (SUPPORTED_FILES.includes(fileExt)) {
        try {
          const moduleInfo = this.getModuleInfo(id);
          if (moduleInfo?.isEntry) isEntry = true;
        } catch {
          // vite 6 throws "isEntry property of ModuleInfo is not supported" in dev
        }
        // The moduleIds[0] heuristic is only for dev, where isEntry is
        // unavailable. During builds isEntry is authoritative — and under
        // rolldown's parallel transforms, moduleIds[0] is timing-dependent and
        // can misfire, injecting the init module into an arbitrary module
        // (e.g. react-dom's CJS internals, where its top-level await then
        // breaks require() paths — see issue #893).
        if (!isEntry && isDevEnv) {
          const moduleIds = Array.from(this.getModuleIds());
          if (moduleIds[0] === id) isEntry = true;
        }
      }
      if (vitePluginOptions?.ssrEntryModuleIds?.includes(id)) isEntry = true;

      if (isEntry) {
        debug(`detected entry: ${id}`);

        const injectCode = ['// INJECTED BY @varlock/vite-integration ----'];

        if (options?.ssr) {
          // SSR entry: import the virtual init module. It has no transitive deps
          // on user code so the bundler evaluates it first — ensuring
          // initVarlockEnv() runs before any user modules.
          injectCode.push(`import '${VARLOCK_INIT_MODULE_ID}';`);
        } else {
          // Client entry
          injectCode.push('globalThis.__varlockThrowOnMissingKeys = true;');
          if (isDevEnv) {
            injectCode.push(
              `globalThis.__varlockValidKeys = ${JSON.stringify(Object.keys(varlockLoadedEnv?.config || {}))};`,
            );
          }
          injectCode.push(
            `globalThis.__varlockPublicDynamicKeys = ${JSON.stringify(publicDynamicKeys)};`,
          );
        }

        injectCode.push('// -------- ');

        magicString ||= new MagicString(code);
        magicString.prepend(`${injectCode.join('\n')}\n`);
      }

      if (!magicString) return null;
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ source: code, includeContent: true, hires: true }),
      };
    },
    renderChunk(code, chunk) {
      // Not 100% positive this is necessary if we've already replaced in transform
      // but the rollup-plugin-define we used as a reference did it, so we'll keep it

      // replace build-time ENV.x references
      const magicString = replacerFn(this, code, chunk.fileName);

      if (!magicString) return null;
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ source: code, includeContent: true, hires: true }),
      };
    },

    // this enables replacing %ENV.xxx% constants in html entry-point files
    // see https://vite.dev/guide/env-and-mode.html#html-constant-replacement
    transformIndexHtml(html) {
      debug('transformIndexHtml called, configIsValid =', configIsValid);
      if (!configIsValid) {
        return buildErrorPageHtml(varlockLastError);
      }

      //! Note on vite's built-in html constant replacement
      // when using config.define, any import.meta.env.XXX replacements
      // would be automatically added as constant replacements (%XXX%)
      const replacedHtml = html.replace(
        // look for "%ENV.xxx%"
        /%ENV\.([a-zA-Z_][a-zA-Z0-9._]*)%/g,
        (_fullMatch, itemKey) => {
          if (!varlockLoadedEnv.config[itemKey]) {
            throw new Error(`Config item \`${itemKey}\` does not exist`);
          } else if (varlockLoadedEnv.config[itemKey].isSensitive) {
            // sensitive items are dynamic (not inlineable) by default, but the reason that
            // matters to the user here is the secrecy one - lead with that
            throw new Error(`Config item \`${itemKey}\` is sensitive and cannot be used in html replacements`);
          } else if (varlockLoadedEnv.config[itemKey].isDynamic) {
            throw new Error(`Config item \`${itemKey}\` is dynamic (runtime-resolved) and cannot be used in html replacements`);
          } else {
            // undefined will be turned into empty string in html replacements
            return varlockLoadedEnv.config[itemKey].value ?? '';
          }
        },
      );

      return replacedHtml;
    },
  } satisfies Plugin;
}
