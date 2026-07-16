import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDebug } from 'varlock';
import { scanForLeaks, varlockSettings } from 'varlock/env';
import { varlockVitePlugin } from '@varlock/vite-integration';
import type { AstroIntegration } from 'astro';

const debug = createDebug('varlock:astro-integration');

debug('Loaded varlock astro integration file');

function varlockAstroIntegration(
  // re-expose all options from vite plugin
  integrationOptions?: Parameters<typeof varlockVitePlugin>[0],
): AstroIntegration {
  // captured in astro:config:setup (the only hook that exposes it) and read
  // in astro:config:done, which is where we know the adapter
  let command: 'dev' | 'build' | 'preview' | 'sync' = 'build';

  return {
    name: 'varlock-astro-integration',
    hooks: {
      'astro:config:setup': (opts) => {
        command = opts.command;
      },

      // docs say to use astro:config:setup hook to adjust vite config
      // but we wait to until here because we don't know the adapter yet
      // and we want to use that to infer ssrInjectMode
      'astro:config:done': async (opts) => {
        const adapterName = opts.config.adapter?.name;

        let ssrInjectMode = integrationOptions?.ssrInjectMode;
        let vitePluginOptions: Parameters<typeof varlockVitePlugin>[0] = {
          ...integrationOptions,
        };

        if (['@astrojs/netlify', '@astrojs/vercel'].includes(adapterName || '')) {
          ssrInjectMode ??= 'resolved-env';
        } else if (adapterName === '@astrojs/node') {
          ssrInjectMode ??= 'auto-load';
        }

        if (adapterName === '@astrojs/cloudflare') {
          // @astrojs/cloudflare runs SSR in workerd via @cloudflare/vite-plugin.
          // Inject varlock init into the CF worker entry and load env from bindings
          // at runtime in production (via varlock-wrangler deploy) — so we
          // deliberately don't default ssrInjectMode to 'resolved-env' for builds,
          // since the runtime loader below already hydrates env from Cloudflare
          // bindings and baking would just ship secrets in the worker artifact
          // that are never read.
          // In `astro dev`, though, @astrojs/cloudflare owns its own
          // @cloudflare/vite-plugin instance with no binding-injection hook for
          // varlock to use (that only exists inside `varlockCloudflareVitePlugin`,
          // which Astro doesn't use) — resolved-env is the only way to get real
          // values into the dev worker, so default to it there.
          if (command === 'dev') ssrInjectMode ??= 'resolved-env';

          let cloudflareSsrEntryCode: string;
          let logVarlockEnvInjectionNotice: () => void;
          try {
            const cfIntegration = await import('@varlock/cloudflare-integration/ssr-entry-code');
            ({ CLOUDFLARE_SSR_ENTRY_CODE: cloudflareSsrEntryCode, logVarlockEnvInjectionNotice } = cfIntegration);
            // @astrojs/cloudflare uses @cloudflare/vite-plugin, which otherwise
            // auto-loads .env and logs "Using secrets defined in .env" — opt out
            // so varlock is the only source of env for the worker.
            cfIntegration.disableWranglerDotEnvAutoload();
          } catch {
            throw new Error(
              '[varlock] Using @astrojs/cloudflare requires @varlock/cloudflare-integration.\n'
              + 'Install it alongside @varlock/astro-integration: npm install @varlock/cloudflare-integration',
            );
          }

          vitePluginOptions = {
            ...vitePluginOptions,
            ssrInjectMode,
            ssrEdgeRuntime: vitePluginOptions.ssrEdgeRuntime ?? true,
            ssrEntryModuleIds: [
              ...(vitePluginOptions.ssrEntryModuleIds ?? []),
              '\0virtual:cloudflare/worker-entry',
            ],
            ssrEntryCode: vitePluginOptions.ssrEntryCode ?? [cloudflareSsrEntryCode],
            isCloudflareTarget: true,
          };

          // Print a varlock notice at server start, in place of wrangler's
          // suppressed "Using secrets defined in .env" message.
          opts.config.vite.plugins ||= [];
          opts.config.vite.plugins.push({
            name: 'varlock-cloudflare-env-notice',
            configureServer() { logVarlockEnvInjectionNotice(); },
            configurePreviewServer() { logVarlockEnvInjectionNotice(); },
          } as any);
        } else {
          vitePluginOptions = { ...vitePluginOptions, ssrInjectMode };
        }

        opts.config.vite.plugins ||= [];
        opts.config.vite?.plugins?.push(
          varlockVitePlugin({
            ...vitePluginOptions,
            integrationTelemetry: integrationOptions?.integrationTelemetry ?? {
              name: __VARLOCK_INTEGRATION_NAME__,
              version: __VARLOCK_INTEGRATION_VERSION__,
            },
          }) as any,
        );
      },

      // Scan generated static HTML files for leaked secrets after build.
      // SSR responses are already protected by the Vite plugin's
      // patchGlobalServerResponse(), but static output written to disk
      // needs explicit scanning.
      'astro:build:done': async ({ dir }) => {
        if (varlockSettings.preventLeaks === false) return;

        const outDir = fileURLToPath(dir);
        debug('scanning build output for leaks in', outDir);

        const leakedFiles: Array<string> = [];
        for await (const file of fs.promises.glob(`${outDir}/**/*.html`)) {
          const fileContents = await fs.promises.readFile(file, 'utf8');
          try {
            scanForLeaks(fileContents, { method: 'astro post-build scan', file });
          } catch (_err) {
            leakedFiles.push(file);
          }
        }

        if (leakedFiles.length > 0) {
          throw new Error(
            `Build aborted: ${leakedFiles.length} file(s) contain leaked sensitive config`,
          );
        }
      },
    },
  };
}

export default varlockAstroIntegration;
