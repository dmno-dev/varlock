import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import varlockAstroIntegration from '@varlock/astro-integration';

export default defineConfig({
  integrations: [varlockAstroIntegration({ ssrInjectMode: 'resolved-env' })],
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
