import { defineConfig } from 'vite';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { ENV } from 'varlock';

console.log('loaded env from varlock: ', {
  APP_ENV: ENV.APP_ENV,
  SECRET_FOO: ENV.SECRET_FOO,
});

export default defineConfig({
  plugins: [varlockVitePlugin() as any],
});
