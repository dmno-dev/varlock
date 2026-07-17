import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import varlockAstroIntegration from '@varlock/astro-integration';

export default defineConfig({
  integrations: [varlockAstroIntegration(), react()],
  output: 'static',
  adapter: cloudflare(),
});
