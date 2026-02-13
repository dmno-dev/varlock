import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000, // Some tests involve building frameworks
    hookTimeout: 30000,
    globals: true,
  },
});
