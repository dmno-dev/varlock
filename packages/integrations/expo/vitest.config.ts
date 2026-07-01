import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  test: {
    name: '@varlock/expo-integration',
  },
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
});
