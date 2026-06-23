import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import varlockAstroIntegration from '@varlock/astro-integration';

export default defineConfig({
  integrations: [varlockAstroIntegration()],
  output: 'server',
  adapter: cloudflare(),
});
