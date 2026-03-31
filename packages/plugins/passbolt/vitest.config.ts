import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['ts-src'],
  },
  define: {
    __VARLOCK_BUILD_TYPE__: JSON.stringify('test'),
    __VARLOCK_SEA_BUILD__: 'false',
  },
});
