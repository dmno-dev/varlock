import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    name: '@varlock/alchemy-integration',
  },
});
