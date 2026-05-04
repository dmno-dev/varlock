/* eslint-disable no-console */

import path from 'node:path';
import type { Plugin } from 'vite';
import MagicString from 'magic-string';

import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';
import { createDebug, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';

import { createReplacerTransformFn, SUPPORTED_FILES } from './transform';


// enables throwing when user accesses a bad key on ENV
(globalThis as any).__varlockThrowOnMissingKeys = true;

// snapshot process.env before varlock modifies it via initVarlockEnv()
const originalProcessEnv = { ...process.env };

const debug = createDebug('varlock:vite-integration');

let isFirstLoad = !(process as any).__VARLOCK_ENV;

debug('varlock vite plugin loaded. first load = ', isFirstLoad);

let isDevCommand: boolean;
let configIsValid = true;
export let varlockLoadedEnv: SerializedEnvGraph;
let staticReplacements: Record<string, any> = {};
let replacerFn: ReturnType<typeof createReplacerTransformFn>;


function resetStaticReplacements() {
  staticReplacements = {};
  for (const itemKey in varlockLoadedEnv?.config) {
    const itemInfo = varlockLoadedEnv.config[itemKey];
    // TODO: probably reimplement static/dynamic controls here too
    if (!itemInfo.isSensitive) {
      // we have to pass in a string of 'undefined' so it gets replaced properly
      const val = itemInfo.value === undefined ? 'undefined' : JSON.stringify(itemInfo.value);
      staticReplacements[`ENV.${itemKey}`] = val;
    }
  }

  debug('static replacements', staticReplacements);

  replacerFn = createReplacerTransformFn({
    replacements: staticReplacements,
  });
}


let loadCount = 0;
function reloadConfig(cwd?: string) {
  debug('loading config - count =', ++loadCount, cwd ? `(cwd: ${cwd})` : '');
  try {
    const { stdout } = execSyncVarlock('load --format json-full --compact', {
      fullResult: true,
      env: originalProcessEnv,
      ...(cwd && { cwd }),
    });
    process.env.__VARLOCK_ENV = stdout;
    varlockLoadedEnv = JSON.parse(stdout) as SerializedEnvGraph;
    configIsValid = true;
  } catch (err) {
    // CLI exits non-zero on validation failure but still outputs JSON to stdout.
    // Try to parse it so we have sources (for file watching) and error details.
    if (err instanceof VarlockExecError) {
      if (err.stdout) {
        try {
          varlockLoadedEnv = JSON.parse(err.stdout) as SerializedEnvGraph;
        } catch { /* not parseable — hard failure */ }
      }
      if (err.stderr) console.error(err.stderr);
    }
    configIsValid = false;
    resetStaticReplacements();
    return;
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
}

// Return type is `any` instead of `Plugin` to avoid symlink type conflicts.
// When this package is symlinked for local dev, TypeScript resolves `vite`'s
// Plugin type from this package's node_modules — a different copy than the
// consumer's — causing spurious type errors. Since Vite's `plugins` config
// is loosely typed, this is functionally equivalent.
export function varlockVitePlugin(
  vitePluginOptions?: VarlockVitePluginOptions,
): any {
  // tracks which SSR environments have already had init code injected
  // to prevent duplicate injection when multiple modules are detected as entries
  const injectedSsrEnvironments = new Set<string>();

  return {
    name: 'inject-varlock-config',
    enforce: 'post',

    buildStart() {
      injectedSsrEnvironments.clear();
    },

    // hook to modify config before it is resolved
    async config(config, env) {
      debug('vite plugin - config fn called');

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

      // Determine the project root for the current Vite/Vitest project.
      // In monorepo setups with Vitest workspace projects, config.root
      // points to the child package directory rather than the monorepo root
      // where process.cwd() points. We need to reload varlock from the
      // correct directory so it can find .env.schema and .env files.
      const projectRoot = config.root ? path.resolve(config.root) : undefined;
      const rootDiffersFromCwd = !!(projectRoot && path.relative(projectRoot, process.cwd()) !== '');

      if (rootDiffersFromCwd) {
        // Always reload with the correct project root when it differs from
        // cwd. This handles monorepo Vitest workspace setups where each child
        // project has its own env files — even if the monorepo root also has
        // env files (which would cause the initial module-level load to
        // succeed with the wrong project's config).
        reloadConfig(projectRoot);
      } else if (isFirstLoad) {
        isFirstLoad = false;
        // Roots match — the module-level reloadConfig() already loaded from
        // the correct directory, no need to reload.
      } else if (isDevCommand) {
        // Dev mode re-trigger (e.g., after .env file updates)
        // TODO: be smarter about only reloading if the env files changed?
        reloadConfig();
      }

      // we do not want to inject via config.define - instead we use @rollup/plugin-replace

      // Exclude varlock from dep optimization.
      // `varlock/env` is a runtime proxy that breaks if pre-bundled by
      // esbuild/rolldown — especially in Cloudflare worker environments
      // where the optimizer runs separately and can lose the pre-bundled
      // file after re-optimization cycles.
      const varlockExclude = ['varlock', 'varlock/env', 'varlock/patch-console', 'varlock/patch-response'];
      config.optimizeDeps ??= {};
      config.optimizeDeps.exclude = [
        ...config.optimizeDeps.exclude ?? [],
        ...varlockExclude,
      ];
      config.ssr ??= {};
      config.ssr.optimizeDeps ??= {};
      config.ssr.optimizeDeps.exclude = [
        ...config.ssr.optimizeDeps.exclude ?? [],
        ...varlockExclude,
      ];
      // For Vite 7+, per-environment excludes are handled by the
      // `configEnvironment` hook below. For Vite 6, `configResolved`
      // patches all resolved environments.

      if (!configIsValid) {
        if (isDevCommand) {
          // adjust vite's setting so it doesnt bury the error messages
          config.clearScreen = false;
        } else {
          console.log('💥 Varlock config validation failed 💥');
          if (varlockLoadedEnv?.errors?.root) {
            for (const msg of varlockLoadedEnv.errors.root) {
              console.log(`  - ${msg}`);
            }
          }
          if (varlockLoadedEnv?.errors?.configItems) {
            for (const [key, msg] of Object.entries(varlockLoadedEnv.errors.configItems)) {
              console.log(`  - ${key}: ${msg}`);
            }
          }
          // throwing an error spits out a big useless stack trace... so better to just exit?
          process.exit(1);
        }
      }
    },
    // Vite 6+ hook: runs for each environment (client, ssr, worker, etc.)
    // Ensures varlock is excluded from dep optimization in every environment,
    // including Cloudflare worker environments created by @cloudflare/vite-plugin.
    configEnvironment(_name: string, envConfig: any) {
      const varlockExclude = ['varlock', 'varlock/env', 'varlock/patch-console', 'varlock/patch-response'];
      envConfig.dev ??= {};
      envConfig.dev.optimizeDeps ??= {};
      envConfig.dev.optimizeDeps.exclude = [
        ...envConfig.dev.optimizeDeps.exclude ?? [],
        ...varlockExclude,
      ];
      // Also set at the environment level (Vite 6 uses this path)
      envConfig.optimizeDeps ??= {};
      envConfig.optimizeDeps.exclude = [
        ...envConfig.optimizeDeps.exclude ?? [],
        ...varlockExclude,
      ];
    },
    // hook to observe/modify config after it is resolved
    configResolved(config) {
      debug('vite plugin - configResolved fn called');

      // Patch per-environment optimizeDeps for Vite 6 (which lacks
      // the `configEnvironment` hook). By this point all plugins have
      // registered their environments, so we can patch them all.
      // The resolved config is technically frozen, but `optimizeDeps`
      // objects within environments are still mutable in practice.
      const varlockExclude = ['varlock', 'varlock/env', 'varlock/patch-console', 'varlock/patch-response'];
      if ((config as any).environments) {
        for (const envName of Object.keys((config as any).environments)) {
          const envConf = (config as any).environments[envName];
          if (envConf?.dev?.optimizeDeps) {
            envConf.dev.optimizeDeps.exclude = [
              ...envConf.dev.optimizeDeps.exclude ?? [],
              ...varlockExclude,
            ];
          }
          if (envConf?.optimizeDeps) {
            envConf.optimizeDeps.exclude = [
              ...envConf.optimizeDeps.exclude ?? [],
              ...varlockExclude,
            ];
          }
        }
      }

      if (!varlockLoadedEnv) return;
      // inject all .env files that varlock loaded into `configFileDependencies`
      // so that vite will watch them and reload if they change
      for (const varlockSource of varlockLoadedEnv.sources) {
        if (!varlockSource.enabled) continue;
        if (varlockLoadedEnv.basePath && varlockSource.path) {
          config.configFileDependencies.push(path.resolve(varlockLoadedEnv.basePath, varlockSource.path));
        }
      }
    },
    // hook to configure vite dev server
    async configureServer(server) {
      debug('vite plugin - configureServer fn called');

      if (!configIsValid) {
        // triggers the built-in vite error overlay
        server.middlewares.use((req, res, next) => {
          server.hot.send({
            type: 'error',
            err: {
              plugin: 'varlock',
              message: 'Your config is currently invalid - check your terminal for more details',
              stack: '',
            },
          });
          return next();
        });
      }
    },

    transform(code, id, options) {
      // replace build-time ENV.x references
      let magicString = replacerFn(this, code, id);

      // we need to detect if this module is one of our worker entry points
      // when running `vite build`, we could use `this.getModuleInfo(id).isEntry`
      // but that doesnt work in dev, so we try to detect it another way
      const fileExt = id.split('?')[0].split('#')[0].split('.').pop() || '';
      let isEntry = false;
      if (SUPPORTED_FILES.includes(fileExt)) {
        // In build mode, getModuleInfo(id).isEntry is reliable.
        // In dev mode it's not supported (vite 6 throws, others return undefined),
        // so fall back to checking if this is the first module in the graph.
        try {
          const moduleInfo = this.getModuleInfo(id);
          if (moduleInfo?.isEntry) isEntry = true;
        } catch {
          // vite 6 throws "isEntry property of ModuleInfo is not supported" in dev
        }
        if (!isEntry) {
          const moduleIds = Array.from(this.getModuleIds());
          if (moduleIds[0] === id) isEntry = true;
        }
      }

      // allow integrations to register additional virtual module IDs as entry points
      if (vitePluginOptions?.ssrEntryModuleIds?.includes(id)) isEntry = true;

      if (isEntry) {
        debug(`detected entry: ${id}`);
        // using env.command (in config hook) is misleading
        // because some frameworks (react router) boot dev servers during the build process
        // even during the build, there are multiple environments
        // but at least this seems to work for our needs
        let isDevEnv = false;

        // ! environments are only supported in vite 6+
        // so we try to make sure it still works in vite 5 too
        if (this.environment) {
          isDevEnv = this.environment.mode === 'dev';
        } else {
          isDevEnv = isDevCommand;
        }

        const injectCode = [
          '// INJECTED BY @varlock/vite-integration ----',
          'globalThis.__varlockThrowOnMissingKeys = true;',
        ];

        // on the code intended for the backend we'll inject init logic
        // and code to load our env, or the already resolved env
        // TODO: keep an eye on environments API, as single ssr flag may be phased out
        if (options?.ssr) {
          // In build mode, prevent duplicate SSR init injection when multiple
          // modules are detected as entries within the same environment (e.g.,
          // TanStack Start + Cloudflare where both the framework entry and the
          // CF virtual worker entry match).
          // In dev mode, skip dedup — Vite may re-transform the entry after
          // dependency re-optimization, and the init code must be re-injected.
          const envKey = this.environment?.name ?? '__ssr__';
          if (!isDevEnv && injectedSsrEnvironments.has(envKey)) {
            debug(`skipping duplicate SSR injection for env "${envKey}"`);
          } else {
            injectedSsrEnvironments.add(envKey);

            const ssrInjectMode = vitePluginOptions?.ssrInjectMode ?? 'init-only';
            const isEdgeRuntime = vitePluginOptions?.ssrEdgeRuntime ?? false;

            debug('ssrInjectMode =', ssrInjectMode, 'isDev =', isDevEnv);
            if (ssrInjectMode === 'auto-load') {
              injectCode.push(
                "import 'varlock/auto-load';",
              );
            } else {
              if (ssrInjectMode === 'resolved-env') {
                injectCode.push(`globalThis.__varlockLoadedEnv = ${JSON.stringify(varlockLoadedEnv)};`);
              }

              // inject custom entry code from integrations
              if (vitePluginOptions?.ssrEntryCode?.length) {
                injectCode.push(...vitePluginOptions.ssrEntryCode);
              }

              // TODO: we may want to move this to a single module we import
              injectCode.push(
                "import { initVarlockEnv } from 'varlock/env';",
                "import { patchGlobalConsole } from 'varlock/patch-console';",
                "import { patchGlobalResponse } from 'varlock/patch-response';",
              );
              // edge runtimes don't have node:http ServerResponse
              if (!isEdgeRuntime) {
                injectCode.push(
                  "import { patchGlobalServerResponse } from 'varlock/patch-server-response';",
                );
              }
              injectCode.push(
                'initVarlockEnv();',
                'patchGlobalConsole();',
              );
              if (!isEdgeRuntime) {
                injectCode.push('patchGlobalServerResponse();');
              }
              injectCode.push('patchGlobalResponse();');
            }
          }

        // this build is for the client
        } else {
          // in dev mode, on the client we'll inject a list of the existing keys, to provide better error messages
          if (isDevEnv) {
            injectCode.push(
              '// NOTE - __varlockValidKeys is only injected during development',
              `globalThis.__varlockValidKeys = ${JSON.stringify(Object.keys(varlockLoadedEnv?.config || {}))};`,
            );
          }
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
      if (!configIsValid) {
        // TODO: build a nice error page somehow and just use it here
        // we should be showing you specific errors and have links to the right files/lines where possible
        return `
<html>
<head>
  <script type="module" src="/@vite/client"></script>
  <title>Invalid config</title>
</head>
<body>
  <h2>Your varlock config is currently invalid!</h2>
  <p>Check your terminal for more details</p>
</body>
</html>
        `;
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
            throw new Error(`Config item \`${itemKey}\` is sensitive and cannot be used in html replacements`);
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
