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
  return {
    name: 'varlock-astro-integration',
    hooks: {
      // docs say to use astro:config:setup hook to adjust vite config
      // but we wait to until here because we don't know the adapter yet
      // and we want to use that to infer ssrInjectMode
      'astro:config:done': async (opts) => {
        const adapterName = opts.config.adapter?.name;

        let ssrInjectMode = integrationOptions?.ssrInjectMode;
        let vitePluginOptions: Parameters<typeof varlockVitePlugin>[0] = {
          ...integrationOptions,
        };

        if (['@astrojs/netlify', '@astrojs/vercel', '@astrojs/cloudflare'].includes(adapterName || '')) {
          ssrInjectMode ??= 'resolved-env';
        } else if (adapterName === '@astrojs/node') {
          ssrInjectMode ??= 'auto-load';
        }

        if (adapterName === '@astrojs/cloudflare') {
          // @astrojs/cloudflare runs SSR in workerd via @cloudflare/vite-plugin.
          // Inject varlock init into the CF worker entry and load env from bindings
          // at runtime in production (via varlock-wrangler deploy).
          let cloudflareSsrEntryCode: string;
          try {
            ({ CLOUDFLARE_SSR_ENTRY_CODE: cloudflareSsrEntryCode } = await import('@varlock/cloudflare-integration/ssr-entry-code'));
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
          };
        } else {
          vitePluginOptions = { ...vitePluginOptions, ssrInjectMode };
        }

        opts.config.vite.plugins ||= [];
        opts.config.vite?.plugins?.push(
          varlockVitePlugin(vitePluginOptions) as any,
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
