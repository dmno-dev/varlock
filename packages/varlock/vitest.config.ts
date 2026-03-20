import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __VARLOCK_BUILD_TYPE__: JSON.stringify('test'),
    __VARLOCK_SEA_BUILD__: 'false',
  },
});
