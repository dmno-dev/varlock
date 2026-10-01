import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 180_000,
    globals: true,
    include: ['frameworks/**/*.test.ts', 'deploy/**/*.test.ts'],
    pool: 'forks',
    // Run test files sequentially — these tests spawn heavy dev servers
    // (wrangler/workerd, next dev, vite dev) that exhaust CI runner resources
    // when running concurrently
    fileParallelism: false,
    teardownTimeout: 30_000,
  },
});
