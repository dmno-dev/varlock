import { defineConfig, type ViteUserConfig } from 'vitest/config';

// Shared settings for both projects: varlock's ts-src condition + build-type defines.
const shared = {
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
} satisfies ViteUserConfig;

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'effect4',
          include: ['test/**/*.test.ts'],
          exclude: ['test/effect3/**'],
        },
      },
      {
        // test/effect3 is its own workspace package pinned to Effect 3, so `effect/*`
        // imports there resolve to test/effect3/node_modules/effect
        ...shared,
        test: {
          name: 'effect3',
          include: ['test/effect3/**/*.test.ts'],
        },
      },
    ],
  },
});
