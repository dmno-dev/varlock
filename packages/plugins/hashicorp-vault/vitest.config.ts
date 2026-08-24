import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['ts-src'],
  },
  ssr: {
    // vitest resolves dependencies through the ssr pipeline, which does not inherit
    // resolve.conditions. Without this, `varlock/test-helpers` (a ts-src-only export,
    // deliberately not published) fails with "No known conditions".
    resolve: {
      conditions: ['ts-src'],
    },
  },
  define: {
    __VARLOCK_BUILD_TYPE__: JSON.stringify('test'),
    __VARLOCK_SEA_BUILD__: 'false',
  },
});
