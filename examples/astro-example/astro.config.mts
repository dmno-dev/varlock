import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import mdx from '@astrojs/mdx';
import varlockAstroIntegration from '@varlock/astro-integration';

import node from '@astrojs/node';
import cloudflare from '@astrojs/cloudflare';
import netlify from '@astrojs/netlify';
import vercel from '@astrojs/vercel';

import { ENV } from 'varlock/env';

console.log('using ENV in astro config -- ', ENV.APP_ENV, ENV.SECRET_FOO);

// https://astro.build/config
export default defineConfig({
  integrations: [
    varlockAstroIntegration(),
    vue(),
    mdx(),
  ],

  ...process.env.TEST_ASTRO_ADAPTER === 'node' && {
    output: 'server',
    adapter: node({
      mode: 'standalone',
    }),
  },

  ...process.env.TEST_ASTRO_ADAPTER === 'cloudflare' && {
    adapter: cloudflare(),
  },
  ...process.env.TEST_ASTRO_ADAPTER === 'netlify' && {
    adapter: netlify({
      // edgeMiddleware: true,
    }),
  },
  ...process.env.TEST_ASTRO_ADAPTER === 'vercel' && {
    output: 'server',
    adapter: vercel({
      // edgeMiddleware: true,
    }),
  },
});
