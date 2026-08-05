import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  resolve: {
    // resolve workspace deps to their TS source so tests don't need a build step
    conditions: ['ts-src'],
  },
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
});
