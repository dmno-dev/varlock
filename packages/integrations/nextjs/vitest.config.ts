import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watchTriggerPatterns: [
      {
        pattern: /test\/test-project\/.*/,
        testsToRun: () => [],
      },
    ],
    testTimeout: 30000,
  },
});
