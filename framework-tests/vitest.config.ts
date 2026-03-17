import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 180_000,
    globals: true,
    include: ['frameworks/**/*.test.ts'],
    pool: 'forks',
    teardownTimeout: 30_000,
  },
});
