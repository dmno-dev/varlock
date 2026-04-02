import { defineConfig } from 'astro/config';
import varlockAstroIntegration from '@varlock/astro-integration';
import { ENV } from 'varlock/env';

// Verify that env vars are accessible within the astro config file
// If ENV.PUBLIC_VAR is not available, this will throw and the build will fail
const configPublicVar = ENV.PUBLIC_VAR;
if (configPublicVar !== 'public-var-value') {
  throw new Error(`PUBLIC_VAR not available in astro config (got: ${configPublicVar})`);
}

export default defineConfig({
  integrations: [varlockAstroIntegration()],
  output: 'static',
  // Use the env var in the site config to prove it was accessible
  site: `https://${configPublicVar}.example.com`,
});
