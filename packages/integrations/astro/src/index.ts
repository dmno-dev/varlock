import { createDebug } from 'varlock';
import { varlockVitePlugin } from '@varlock/vite-integration';
import type { AstroIntegration } from 'astro';

const debug = createDebug('varlock:astro-integration');

debug('Loaded varlock astro integration file');
const startLoadAt = new Date();

const loadingTime = +new Date() - +startLoadAt;
debug(`Initial varlock env load completed in ${loadingTime}ms`);

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
        if (['@astrojs/netlify', '@astrojs/vercel', '@astrojs/cloudflare'].includes(adapterName || '')) {
          ssrInjectMode ??= 'resolved-env';
        } else if (adapterName === '@astrojs/node') {
          ssrInjectMode ??= 'auto-load';
        }

        opts.config.vite.plugins ||= [];
        opts.config.vite?.plugins?.push(
          varlockVitePlugin({
            ...integrationOptions,
            ssrInjectMode,
          }) as any,
        );
      },

      // TODO: re-enable checking for dynamic config used during pre-render
    },
  };
}

export default varlockAstroIntegration;
