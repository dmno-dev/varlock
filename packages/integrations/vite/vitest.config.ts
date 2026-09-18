import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  test: {
    name: '@varlock/vite-integration',
    // the first test to import the plugin pays for transforming it plus the
    // varlock source it pulls in (ts-src conditions), and CI runs several
    // integration packages' tests concurrently; the 5s default was flaky there
    testTimeout: 20_000,
  },
  resolve: {
    // resolve `varlock` subpath imports from source, so tests do not depend on
    // the sibling package having been built first
    conditions: ['ts-src'],
  },
  ssr: {
    // vitest resolves dependencies through the ssr pipeline, which does not
    // inherit resolve.conditions
    resolve: {
      conditions: ['ts-src'],
    },
  },
  define: {
    __VARLOCK_INTEGRATION_NAME__: JSON.stringify(pkg.name),
    __VARLOCK_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
    __VARLOCK_BUILD_TYPE__: JSON.stringify('test'),
    __VARLOCK_SEA_BUILD__: 'false',
  },
});
