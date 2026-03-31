import { defineConfig } from 'astro/config';
import varlockAstroIntegration from '@varlock/astro-integration';

export default defineConfig({
  integrations: [varlockAstroIntegration()],
  output: 'static',
});
