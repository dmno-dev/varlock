import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { ENV } from 'varlock/env';

// This should be redacted in build output
console.log('secret-log-test:', ENV.SECRET_KEY);

export default defineConfig({
  plugins: [varlockVitePlugin()],
});
