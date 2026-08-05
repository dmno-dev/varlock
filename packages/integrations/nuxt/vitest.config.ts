import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  resolve: {
    alias: {
      '@varlock/vite-integration': fileURLToPath(new URL('../vite/src/index.ts', import.meta.url)),
    },
  },
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
});
