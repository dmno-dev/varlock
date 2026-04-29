import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Prevent vite:esbuild from walking up to the root tsconfig.json
    // which extends @varlock/tsconfig (unavailable in smoke-test pnpm environment)
    tsconfigRaw: '{}',
  },
  test: {
    testTimeout: 60000, // Some tests involve building frameworks
    hookTimeout: 60000, // Framework builds use 120s per-test overrides
    globals: true,
  },
});
