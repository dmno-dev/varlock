import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { varlockVitePlugin } from '@varlock/vite-integration';
import { ENV } from 'varlock/env';

console.log('loaded env from varlock: ', {
  APP_ENV: ENV.APP_ENV,
  SECRET_FOO: ENV.SECRET_FOO,
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), varlockVitePlugin() as any],
});
