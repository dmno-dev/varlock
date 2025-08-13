import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests sequentially to prevent interference between test suites
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Ensure tests run in sequence
    sequence: {
      concurrent: false,
    },
  },
});
