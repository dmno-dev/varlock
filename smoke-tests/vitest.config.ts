import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000, // Some tests involve building frameworks
    hookTimeout: 60000, // Framework builds use 120s per-test overrides
    globals: true,
  },
});
