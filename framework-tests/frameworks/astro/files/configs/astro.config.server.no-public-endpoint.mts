import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import varlockAstroIntegration from '@varlock/astro-integration';

export default defineConfig({
  integrations: [
    varlockAstroIntegration({
      publicDynamicEndpoint: false,
    }),
  ],
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
